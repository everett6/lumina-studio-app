import { $, $$, api, emit, h, on, state, toast } from './lib.js';
import { initCreate } from './create.js';
import { initBooks } from './books.js';
import { initCanvas } from './canvas.js';
import { initCharacters } from './characters.js';
import { initLibrary } from './library.js';
import { initSettings } from './settings.js';
import { initStoryboard } from './storyboard.js';

const views = ['create', 'canvas', 'books', 'library', 'storyboard', 'characters', 'settings'];

export function setTab(tab) {
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.tab === tab));
  for (const view of views) $(`#${view}-view`).classList.toggle('hidden', view !== tab);
  emit('tab', tab);
}

async function loadCatalog() {
  state.catalog = await api('/api/catalog');
  const ready = state.catalog.providers.filter((p) => p.ready && !p.keyless);
  $('#provider-status').replaceChildren(
    h('div.provider-box', {},
      h('span.field-label', {}, 'PROVIDERS'),
      ready.length ? h('p', {}, ready.map((p) => p.label).join(', ')) : h('p.muted', {}, 'No keys yet'),
      h('button.text-button', { onclick: () => setTab('settings') }, ready.length ? 'Manage keys →' : 'Add an API key →')));
  emit('catalog', state.catalog);
}

function renderProjects() {
  $('#project-list').replaceChildren(...state.projects.map((project) => h(`button.project-row${project.id === state.project?.id ? '.active' : ''}`,
    { onclick: () => selectProject(project.id) }, h('span.project-dot'), h('span', {}, project.name))));
  $('#active-project-name').textContent = state.project?.name ?? '';
}

export async function refreshProject() {
  state.detail = await api(`/api/projects/${state.project.id}`);
  state.project = state.detail.project;
  emit('project', state.detail);
}

async function selectProject(id) {
  state.project = state.projects.find((p) => p.id === id) ?? state.projects[0];
  try { localStorage.setItem('lumina-project-id', state.project.id); } catch { /* storage may be unavailable */ }
  renderProjects();
  await refreshProject();
}

async function loadProjects(preferId) {
  state.projects = (await api('/api/projects')).projects;
  if (!state.projects.length) state.projects = [(await api('/api/projects', { method: 'POST', body: { name: 'My first project' } })).project];
  let remembered = null;
  try { remembered = localStorage.getItem('lumina-project-id'); } catch { /* ignore */ }
  const id = [preferId, remembered].find((candidate) => state.projects.some((p) => p.id === candidate)) ?? state.projects[0].id;
  await selectProject(id);
}

async function createProject() {
  const name = prompt('Name this project');
  if (!name?.trim()) return;
  const { project } = await api('/api/projects', { method: 'POST', body: { name } });
  await loadProjects(project.id);
  setTab('create');
}

async function renameProject() {
  const name = prompt('Rename project', state.project.name);
  if (!name?.trim()) return;
  await api(`/api/projects/${state.project.id}`, { method: 'PATCH', body: { name } });
  await loadProjects(state.project.id);
}

async function exportProject() {
  const result = await api(`/api/projects/${state.project.id}/export`, { method: 'POST', body: {} });
  toast(`Exported ${result.assets} image(s) to ${result.folder}`);
}

async function deleteProject() {
  if (!confirm(`Delete "${state.project.name}" and all of its images and canvases? This cannot be undone.`)) return;
  await api(`/api/projects/${state.project.id}`, { method: 'DELETE' });
  try { localStorage.removeItem('lumina-project-id'); } catch { /* ignore */ }
  await loadProjects();
}

const guard = (fn) => async (...args) => {
  try { await fn(...args); } catch (error) { toast(error.message, 'error'); }
};

$$('[data-tab]').forEach((button) => button.addEventListener('click', () => setTab(button.dataset.tab)));
$('#new-project').addEventListener('click', guard(createProject));
$('#rename-project').addEventListener('click', guard(renameProject));
$('#export-project').addEventListener('click', guard(exportProject));
$('#delete-project').addEventListener('click', guard(deleteProject));
document.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey)) return;
  const tab = { 1: 'create', 2: 'canvas', 3: 'books', 4: 'library', 5: 'storyboard', 6: 'characters' }[event.key];
  if (tab) { event.preventDefault(); setTab(tab); }
});
on('keys-changed', guard(loadCatalog));
on('open-tab', setTab);
on('assets-changed', guard(refreshProject));
on('refresh-project', guard(refreshProject));

initCreate();
initCanvas();
initBooks();
initLibrary();
initSettings();
initStoryboard();
initCharacters();

(async () => {
  try {
    await loadCatalog();
    await loadProjects();
  } catch (error) {
    toast(error.status === 401 ? 'Open Lumina from the launch link printed in the terminal, or from the desktop app.' : `Could not load workspace: ${error.message}`, 'error');
  }
})();
