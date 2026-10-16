import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const workerPath = new URL('../local/train_lora.py', import.meta.url).pathname;
const voicePath = new URL('../local/voice_worker.py', import.meta.url).pathname;
const lipsyncPath = new URL('../local/lipsync_worker.py', import.meta.url).pathname;

function python(script, path = workerPath) {
  const result = spawnSync('python3', ['-c', script, path], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, `Python stub harness failed:\n${result.stderr}\n${result.stdout}`);
}

test('drawing reuses the pipeline, passes each request refs, and unloads the adapter when refs disappear', () => {
  python(String.raw`
import ast, os, sys, types

path = sys.argv[1]
tree = ast.parse(open(path, encoding='utf8').read(), filename=path)
needed = {'drawing', 'clear_drawing_pipeline'}
nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in needed]
nodes += [n for n in tree.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'VARIETY' for t in n.targets)]
assert len([n for n in nodes if isinstance(n, ast.FunctionDef)]) == 2

events = []
class ImageRef:
    def __init__(self, path): self.path, self.closed = path, False
    def convert(self, mode): return self
    def close(self): self.closed = True
class ImageAPI:
    refs = []
    @classmethod
    def open(cls, path):
        ref = ImageRef(path); cls.refs.append(ref); return ref
class FakeImage:
    def save(self, path): events.append(('save', path))
class Pipe:
    class Vae:
        def enable_tiling(self): pass
    vae = Vae()
    scheduler = types.SimpleNamespace(config='config')
    def to(self, device): events.append(('to', device)); return self
    def load_ip_adapter(self, *args, **kwargs): events.append(('load_adapter', args, kwargs))
    def unload_ip_adapter(self): events.append(('unload_adapter',))
    def set_ip_adapter_scale(self, scale): events.append(('scale', scale))
    def __call__(self, **kwargs):
        events.append(('call', kwargs))
        return types.SimpleNamespace(images=[FakeImage()])
class PipelineFactory:
    loads = 0
    @classmethod
    def from_pretrained(cls, *args, **kwargs): cls.loads += 1; return Pipe()
class Scheduler:
    @staticmethod
    def from_config(config): return config
class Generator:
    def __init__(self, device): pass
    def manual_seed(self, seed): return self
class NoGrad:
    def __enter__(self): pass
    def __exit__(self, *args): pass
class Cuda:
    def empty_cache(self): events.append(('empty_cache',))

os_api = types.SimpleNamespace(path=types.SimpleNamespace(
    exists=lambda path: True, abspath=os.path.abspath, join=os.path.join,
), makedirs=lambda *args, **kwargs: None)
ns = {
    'os': os_api, 'sys': sys, 'gc': types.SimpleNamespace(collect=lambda: None),
    'torch': types.SimpleNamespace(float16='fp16', no_grad=NoGrad, Generator=Generator, cuda=Cuda()),
    'Image': ImageAPI, 'StableDiffusionXLPipeline': PipelineFactory,
    'EulerAncestralDiscreteScheduler': Scheduler, 'MODEL': 'stub-model',
    'VARIETY': ['pose'] * 8, 'QUALITY': 'quality', 'NEGATIVE': 'negative',
    'send': lambda message: None, 'ease_off': lambda: None,
    'draw_pipe': None, 'draw_pipe_has_adapter': False,
}
exec(compile(ast.Module(body=nodes, type_ignores=[]), path, 'exec'), ns)

base = os.path.abspath(os.getcwd())
request_a = {'out': base, 'images': 8, 'refs': ['ref-a.png'], 'tags': 'tag', 'seed': 1}
request_b = {'out': base, 'images': 8, 'refs': ['ref-b.png'], 'tags': 'tag', 'seed': 2}
request_c = {'out': base, 'images': 8, 'refs': [], 'tags': 'tag', 'seed': 3}
for req in (request_a, request_b, request_c):
    ns['drawing'](req, 'id', only=[0])

assert PipelineFactory.loads == 1, PipelineFactory.loads
calls = [event[1] for event in events if event[0] == 'call']
assert len(calls) == 3
assert calls[0]['ip_adapter_image'][0][0].path == 'ref-a.png'
assert calls[1]['ip_adapter_image'][0][0].path == 'ref-b.png'
assert 'ip_adapter_image' not in calls[2]
assert len([event for event in events if event[0] == 'load_adapter']) == 1
assert len([event for event in events if event[0] == 'unload_adapter']) == 1
assert all(ref.closed for ref in ImageAPI.refs)
assert ns['draw_pipe'] is not None
ns['clear_drawing_pipeline']()
assert ns['draw_pipe'] is None and ns['draw_pipe_has_adapter'] is False
`, workerPath);
});

test('ease_off throttles temperature polling and still cools a hot GPU below its safety margin', () => {
  python(String.raw`
import ast, sys, types
path = sys.argv[1]
tree = ast.parse(open(path, encoding='utf8').read(), filename=path)
node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'ease_off')

clock = {'now': 100.0}
temps = iter([80, 70, 80, 66])
polls, sleeps = [], []
class Time:
    @staticmethod
    def sleep(seconds): sleeps.append(seconds)
    @staticmethod
    def monotonic(): return clock['now']
def temperature():
    value = next(temps); polls.append(value); return value
ns = {
    'time': Time, 'os': types.SimpleNamespace(environ={
        'LUMINA_TRAIN_REST': '0.01', 'LUMINA_TRAIN_MAX_TEMP': '75',
        'LUMINA_TRAIN_TEMP_INTERVAL': '5',
    }), 'gpu_temperature': temperature, 'last_temperature_check': 0.0,
}
exec(compile(ast.Module(body=[node], type_ignores=[]), path, 'exec'), ns)
ns['ease_off']()
assert polls == [80, 70], polls
assert sleeps == [0.01, 2], sleeps

# Within the interval: keep the per-step rest but skip the NVML temperature query.
clock['now'] = 102.0
ns['ease_off']()
assert polls == [80, 70], polls
assert sleeps == [0.01, 2, 0.01], sleeps

# Once the interval expires, temperature polling resumes; the hot card cools below hot - 8.
clock['now'] = 106.0
ns['ease_off']()
assert polls == [80, 70, 80, 66], polls
assert sleeps[-2:] == [0.01, 2], sleeps
`, workerPath);
});

test('LoRA error handling clears traceback frames before collecting GPU allocations', async () => {
  const text = await readFile(workerPath, 'utf8');
  assert.match(text, /traceback\.clear_frames\(error\.\__traceback__\)/);
  assert.match(text, /traceback\.clear_frames\(error\.\__traceback__\)[\s\S]*?gc\.collect\(\)[\s\S]*?torch\.cuda\.empty_cache\(\)/);
});

test('voice and lip-sync failures drop retained GPU models and clear CUDA allocations', async () => {
  const voice = await readFile(voicePath, 'utf8');
  const lipsync = await readFile(lipsyncPath, 'utf8');
  assert.match(voice, /traceback\.clear_frames\(error\.\__traceback__\)/);
  assert.match(voice, /chatterbox = None\s+conversion = None[\s\S]*?torch\.cuda\.empty_cache\(\)/);
  assert.match(lipsync, /traceback\.clear_frames\(error\.\__traceback__\)/);
  assert.match(lipsync, /models\.clear\(\)[\s\S]*?torch\.cuda\.empty_cache\(\)/);
});
