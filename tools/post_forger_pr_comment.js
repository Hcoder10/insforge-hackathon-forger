#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const MARKER = '<!-- forger-pr-guard -->';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function getPullRequestNumber(event) {
  if (event.pull_request?.number) return event.pull_request.number;
  if (event.number && event.pull_request) return event.number;
  return null;
}

function buildBody() {
  const commentPath = path.resolve(process.cwd(), process.env.FORGER_COMMENT_PATH || 'bench/results/demo-recordings/project-review-customer-portal/pr-comment.md');
  const runUrl = process.env.FORGER_RUN_URL || (
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : ''
  );
  const status = process.env.FORGER_CI_STATUS || 'completed';

  let body = '# FORGER PR Guard\n\nForger CI ran, but the PR comment artifact was not produced. Check the workflow logs.';
  if (fs.existsSync(commentPath)) body = fs.readFileSync(commentPath, 'utf8').trim();

  const lines = [MARKER, body, '', '---', `CI status: **${status}**`];
  if (runUrl) lines.push(`Run: ${runUrl}`);
  return `${lines.join('\n')}\n`;
}

async function githubRequest(method, url, token, body) {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'forger-pr-guard',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const message = typeof data === 'string' ? data : data?.message || response.statusText;
    const error = new Error(`GitHub API ${method} ${url} failed: ${response.status} ${message}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function main() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const repository = process.env.GITHUB_REPOSITORY;
  const dryRun = process.argv.includes('--dry-run');
  const body = buildBody();

  if (dryRun) {
    console.log(body);
    return;
  }

  if (!token || !eventPath || !repository) {
    console.log('Forger PR comment skipped: missing GitHub token, event path, or repository.');
    return;
  }

  const event = readJson(eventPath);
  const prNumber = getPullRequestNumber(event);
  if (!prNumber) {
    console.log('Forger PR comment skipped: workflow event is not a pull request.');
    return;
  }

  const api = process.env.GITHUB_API_URL || 'https://api.github.com';
  const commentsUrl = `${api}/repos/${repository}/issues/${prNumber}/comments?per_page=100`;
  try {
    const comments = await githubRequest('GET', commentsUrl, token);
    const existing = comments.find((comment) => typeof comment.body === 'string' && comment.body.includes(MARKER));

    if (existing) {
      await githubRequest('PATCH', existing.url, token, { body });
      console.log(`Updated Forger PR Guard comment on PR #${prNumber}.`);
    } else {
      await githubRequest('POST', `${api}/repos/${repository}/issues/${prNumber}/comments`, token, { body });
      console.log(`Created Forger PR Guard comment on PR #${prNumber}.`);
    }
  } catch (error) {
    const permissionError = error.status === 403 || error.status === 404;
    if (!process.env.FORGER_COMMENT_REQUIRED || permissionError) {
      console.warn(`Forger PR comment skipped: ${error.message}`);
      return;
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
