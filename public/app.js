const $ = (selector) => document.querySelector(selector);
const state = { project: null, projects: [], generations: [], references: [], selectedSize: '1024x1024', latest: null, toastTimer: null };
const titleFromPrompt = (prompt) => prompt.trim().split(/\s+/).slice(0, 5).join(' ').replace(/[.,!?;:]$/, '') || 'Untitled campaign';
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
function toast(message) { const node = $('#toast'); node.textContent = message; node.classList.remove('hidden'); clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => node.classList.add('hidden'), 3400); }
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Something went wrong.');
  return body;
}
async function readImageFile(file) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) throw new Error('Choose a PNG, JPEG or WebP image under 8 MB.');
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Could not read this image.')); reader.readAsDataURL(file); });
}
async function ensureProject() {
  const projects = await api('/api/projects'); state.projects = projects.projects;
  const previous = localStorage.getItem('lumina-project-id');
  state.project = state.projects.find((p) => p.id === previous) || state.projects[0] || (await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Untitled campaign' }) })).project;
  localStorage.setItem('lumina-project-id', state.project.id);
  await loadProject(); renderProjects();
}
async function loadProject() {
  const result = await api(`/api/projects/${state.project.id}`); state.project = result.project; state.generations = result.generations.filter((g) => g.status === 'completed');
  $('#active-project-name').textContent = state.project.name;
  renderHistory();
  if (state.generations[0]) showGeneration(state.generations[0]);
}
function renderProjects() {
  const list = $('#project-list'); list.innerHTML = '';
  state.projects.forEach((project) => {
    const row = document.createElement('button'); row.className = `project-row ${project.id === state.project.id ? 'active' : ''}`; row.innerHTML = `<span class="project-dot"></span><span>${escapeHtml(project.name)}</span>`;
    row.addEventListener('click', async () => { state.project = project; state.latest = null; localStorage.setItem('lumina-project-id', project.id); await loadProject(); renderProjects(); }); list.append(row);
  });
}
function renderHistory() {
  $('#history-count').textContent = state.generations.length;
  const grid = $('#history-grid'); grid.innerHTML = '';
  if (!state.generations.length) { grid.innerHTML = '<div class="history-empty">Your generated images will appear here.</div>'; return; }
  state.generations.slice(0, 5).forEach((generation) => {
    const card = document.createElement('button'); card.className = 'history-card'; card.innerHTML = `<div class="history-thumb"><img src="${generation.assetPath}" alt=""></div><b>${escapeHtml(generation.prompt)}</b><small>${new Date(generation.createdAt).toLocaleDateString()}</small>`;
    card.addEventListener('click', () => showGeneration(generation)); grid.append(card);
  });
}
function showGeneration(generation) {
  state.latest = generation;
  const image = $('#result-image'); image.src = generation.assetPath; image.classList.remove('hidden');
  $('#empty-state').classList.add('hidden'); $('#loading-state').classList.add('hidden'); $('#image-overlay').classList.remove('hidden');
  $('#preview-caption').textContent = generation.prompt; $('#variation-btn').classList.remove('hidden');
}
function renderLibrary() {
  const grid = $('#library-grid'); grid.innerHTML = '';
  if (!state.generations.length) { grid.innerHTML = '<div class="history-empty">Create your first image to fill your library.</div>'; return; }
  for (const generation of state.generations) {
    const card = document.createElement('article'); card.className = 'library-card'; card.innerHTML = `<img src="${generation.assetPath}" alt="${escapeHtml(generation.prompt)}"><b>${escapeHtml(generation.prompt)}</b><small>${new Date(generation.createdAt).toLocaleString()}</small>`; grid.append(card);
  }
}
function setTab(tab) {
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.tab === tab));
  $('#create-view').classList.toggle('hidden', tab !== 'create'); $('#canvas-view').classList.toggle('hidden', tab !== 'canvas'); $('#library-view').classList.toggle('hidden', tab !== 'library');
  if (tab === 'library') renderLibrary();
}
async function createProject() {
  const name = prompt('Name this project'); if (!name?.trim()) return;
  try { const result = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name }) }); state.projects.unshift(result.project); state.project = result.project; localStorage.setItem('lumina-project-id', state.project.id); await loadProject(); renderProjects(); setTab('create'); }
  catch (error) { toast(error.message); }
}
async function generate({ sourceAssetId = null, operation = 'generate' } = {}) {
  const promptText = $('#prompt').value.trim();
  if (!promptText) { $('#prompt').focus(); toast('Add an idea to get started.'); return; }
  $('#generate-btn').disabled = true; $('#generate-btn').innerHTML = '<span class="button-spark">✳</span><span>Creating your image…</span>';
  $('#empty-state').classList.add('hidden'); $('#result-image').classList.add('hidden'); $('#image-overlay').classList.add('hidden'); $('#loading-state').classList.remove('hidden');
  try {
    const request = { projectId: state.project.id, prompt: promptText, size: state.selectedSize, quality: $('#quality').value, enhance: true, sourceAssetId, operation, referenceDataUrl: state.references[0] || null };
    const { generation } = await api('/api/generate', { method: 'POST', body: JSON.stringify(request) });
    state.generations.unshift(generation); showGeneration(generation); renderHistory(); $('#preview-caption').textContent = generation.prompt;
    if (generation.enhanced) toast('Creative director refined your prompt.');
    $('#reference-preview').innerHTML = ''; state.references = [];
  } catch (error) {
    $('#loading-state').classList.add('hidden'); if (state.latest) showGeneration(state.latest); else $('#empty-state').classList.remove('hidden'); toast(error.message);
  } finally { $('#generate-btn').disabled = false; $('#generate-btn').innerHTML = '<span class="button-spark">✳</span><span>Generate image</span><span class="button-credit">1 credit</span>'; }
}
$('#prompt').addEventListener('input', () => { $('#char-count').textContent = `${$('#prompt').value.length} / 4000`; });
$('#format-options').addEventListener('click', (event) => { const button = event.target.closest('button[data-size]'); if (!button) return; state.selectedSize = button.dataset.size; $('#format-options').querySelectorAll('button').forEach((item) => item.classList.toggle('selected', item === button)); });
$('#reference-file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0]; if (!file) return;
  try { const dataUrl = await readImageFile(file); state.references = [dataUrl]; $('#reference-preview').innerHTML = `<img src="${dataUrl}" alt="Reference image">`; }
  catch (error) { toast(error.message); }
  event.target.value = '';
});
$('#generate-btn').addEventListener('click', () => generate());
$('#variation-btn').addEventListener('click', () => { if (!state.latest) return; $('#prompt').value = state.latest.prompt; $('#char-count').textContent = `${$('#prompt').value.length} / 4000`; generate({ sourceAssetId: state.latest.assetId, operation: 'variation' }); });
$('#download-btn').addEventListener('click', () => { if (!state.latest) return; const link = document.createElement('a'); link.href = state.latest.assetPath; link.download = `lumina-${state.latest.id}.png`; link.click(); });
$('#add-canvas-btn').addEventListener('click', () => { setTab('canvas'); toast('Image added to your canvas.'); });
$('#canvas-create-link').addEventListener('click', () => setTab('create'));
document.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => setTab(button.dataset.tab)));
document.querySelectorAll('.tiny-plus').forEach((button) => button.addEventListener('click', createProject));
$('#prompt').addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') generate(); });
document.addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key === '1') setTab('create'); if ((event.metaKey || event.ctrlKey) && event.key === '2') setTab('canvas'); });
ensureProject().catch((error) => toast(`Could not load workspace: ${error.message}`));
