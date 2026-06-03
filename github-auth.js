const path = require('path');

function cleanToken(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanRepoName(value) {
  return String(value || '').replace(/\.git$/i, '').replace(/\/+$/g, '');
}

function githubWebUrl(owner, repo) {
  return `https://github.com/${owner}/${repo}`;
}

function isGithubHost(host) {
  const normalized = String(host || '').toLowerCase();
  return normalized === 'github.com' || normalized.includes('github');
}

function parseOwnerRepoPath(pathPart) {
  const parts = String(pathPart || '')
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean);

  if (parts.length < 2) return null;

  const owner = parts[0];
  const repo = cleanRepoName(parts[1]);
  if (!owner || !repo) return null;

  return { owner, repo };
}

function parseGithubRemote(remoteUrl) {
  const raw = typeof remoteUrl === 'string' ? remoteUrl.trim() : '';
  if (!raw) return null;

  const scpLike = raw.match(/^(?:[^@\s/]+@)?([^:\s/]+):(.+)$/);
  if (scpLike) {
    const host = scpLike[1];
    if (!isGithubHost(host)) return null;
    const parsed = parseOwnerRepoPath(scpLike[2]);
    if (!parsed) return null;
    return { ...parsed, host, webUrl: githubWebUrl(parsed.owner, parsed.repo) };
  }

  try {
    const url = new URL(raw);
    const host = url.hostname;
    if (!isGithubHost(host)) return null;
    const parsed = parseOwnerRepoPath(url.pathname);
    if (!parsed) return null;
    return { ...parsed, host, webUrl: githubWebUrl(parsed.owner, parsed.repo) };
  } catch (_) {
    return null;
  }
}

function resolveGithubToken(repoConfig, remoteUrl, config) {
  const repoToken = cleanToken(repoConfig && repoConfig.githubToken);
  if (repoToken) return { token: repoToken, source: 'repo' };

  const parsed = parseGithubRemote(remoteUrl);
  const ownerKey = parsed ? parsed.owner.toLowerCase() : '';
  const accountTokens = config && config.githubAccountTokens && typeof config.githubAccountTokens === 'object'
    ? config.githubAccountTokens
    : {};
  const ownerToken = ownerKey ? cleanToken(accountTokens[ownerKey]) : '';
  if (ownerToken) return { token: ownerToken, source: 'owner' };

  const globalToken = cleanToken(config && config.githubToken);
  if (globalToken) return { token: globalToken, source: 'global' };

  return null;
}

function repoPathKey(repoPath) {
  const raw = typeof repoPath === 'string' ? repoPath.trim() : '';
  if (!raw) return '';

  try {
    return path.resolve(raw).toLowerCase();
  } catch (_) {
    return raw.toLowerCase();
  }
}

function mergeRepoGithubSecrets(existingRepos, nextRepos) {
  const existingByPath = new Map();
  for (const repo of existingRepos || []) {
    const key = repoPathKey(repo && repo.path);
    if (key) existingByPath.set(key, repo);
  }

  return (nextRepos || []).map(repo => {
    const next = { ...(repo || {}) };
    const action = next.githubTokenAction;
    delete next.githubTokenAction;
    const tokenSourcePath = next.githubTokenSourcePath;
    delete next.githubTokenSourcePath;

    const token = cleanToken(next.githubToken);
    delete next.githubToken;

    if (action === 'remove') {
      return next;
    }

    if (token) {
      next.githubToken = token;
      return next;
    }

    const existing =
      existingByPath.get(repoPathKey(next.path)) ||
      existingByPath.get(repoPathKey(tokenSourcePath));
    const existingToken = cleanToken(existing && existing.githubToken);
    if (existingToken) next.githubToken = existingToken;

    return next;
  });
}

module.exports = {
  mergeRepoGithubSecrets,
  parseGithubRemote,
  resolveGithubToken
};
