const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const VERSION = 1;

function filePath() {
  return path.join(app.getPath('userData'), 'projects.json');
}

function emptyData() {
  return { version: VERSION, projects: [] };
}

function normalizeProject(value) {
  if (!value || typeof value !== 'object') return null;
  const id = typeof value.id === 'string' ? value.id : '';
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const projectPath = typeof value.path === 'string' ? value.path : '';
  if (!id || !projectPath) return null;
  return {
    id,
    name: name || path.basename(projectPath) || '本地项目',
    path: projectPath,
    createdAt: Number(value.createdAt) || Date.now(),
    updatedAt: Number(value.updatedAt) || Date.now(),
  };
}

function read() {
  try {
    const raw = fs.readFileSync(filePath(), 'utf8');
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.projects)) return emptyData();
    const seen = new Set();
    const projects = data.projects
      .map(normalizeProject)
      .filter((project) => {
        if (!project || seen.has(project.id)) return false;
        seen.add(project.id);
        return true;
      });
    return { version: VERSION, projects };
  } catch {
    return emptyData();
  }
}

function persist(data) {
  const target = filePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(temp, target);
}

function list() {
  return read().projects;
}

function get(id) {
  return list().find((project) => project.id === id) || null;
}

function upsert(project) {
  const data = read();
  const index = data.projects.findIndex((item) => item.id === project.id);
  if (index >= 0) {
    data.projects[index] = project;
  } else {
    data.projects.push(project);
  }
  persist(data);
  return project;
}

function remove(id) {
  const data = read();
  data.projects = data.projects.filter((project) => project.id !== id);
  persist(data);
}

function reorder(ids) {
  if (!Array.isArray(ids)) throw new Error('顺序无效');
  const data = read();
  const byId = new Map(data.projects.map((project) => [project.id, project]));
  const next = [];
  const seen = new Set();
  for (const id of ids) {
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    const project = byId.get(id);
    if (!project) continue;
    seen.add(id);
    next.push(project);
  }
  for (const project of data.projects) {
    if (!seen.has(project.id)) next.push(project);
  }
  data.projects = next;
  persist(data);
  return data.projects;
}

module.exports = { list, get, upsert, remove, reorder };
