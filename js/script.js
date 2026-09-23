'use strict';

const API_BASE = 'https://api.github.com';
const STORAGE_USER = 'repoCatalogue:lastUser';
const STORAGE_HISTORY = 'repoCatalogue:history';
const STORAGE_SORT = 'repoCatalogue:sort';
const HISTORY_LIMIT = 5;

const MAIN_LANGUAGES = ['JavaScript', 'TypeScript', 'Python', 'Java'];

const USERNAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

const state = {
  user: null,
  repos: [],
  filter: 'All',
  sort: 'stars-desc',
  controller: null,
};

const els = {
  form: document.getElementById('search-form'),
  input: document.getElementById('username'),
  button: document.getElementById('search-btn'),
  error: document.getElementById('username-error'),
  status: document.getElementById('status'),
  results: document.getElementById('results'),
  profile: document.getElementById('profile'),
  grid: document.getElementById('repo-grid'),
  count: document.getElementById('result-count'),
  sort: document.getElementById('sort'),
  tabs: document.querySelectorAll('.tab'),
  recent: document.getElementById('recent'),
  recentList: document.getElementById('recent-list'),
  navToggle: document.querySelector('.nav-toggle'),
  nav: document.getElementById('site-nav'),
  navLinks: document.querySelectorAll('.nav-link'),
  year: document.getElementById('year'),
};

const dateFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium' });
const numberFormat = new Intl.NumberFormat('en');

const storage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
    }
  },
};

function getHistory() {
  try {
    const list = JSON.parse(storage.get(STORAGE_HISTORY));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function rememberUser(login) {
  storage.set(STORAGE_USER, login);
  const history = getHistory().filter((name) => name.toLowerCase() !== login.toLowerCase());
  history.unshift(login);
  storage.set(STORAGE_HISTORY, JSON.stringify(history.slice(0, HISTORY_LIMIT)));
  renderHistory();
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null) continue;
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child != null) node.append(child);
  }
  return node;
}

function validateUsername(value) {
  if (value === '') return 'Please enter a GitHub username.';
  if (value.length > 39) return 'GitHub usernames are at most 39 characters long.';
  if (!USERNAME_PATTERN.test(value)) {
    return 'Use only letters, numbers and single hyphens. A username cannot start or end with a hyphen.';
  }
  return '';
}

function showFieldError(message) {
  els.error.textContent = message;
  els.error.hidden = !message;
  els.input.setAttribute('aria-invalid', message ? 'true' : 'false');
}

class ApiError extends Error {
  constructor(status, response) {
    super(`GitHub API responded with ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.rateLimitRemaining = response.headers.get('x-ratelimit-remaining');
    this.rateLimitReset = response.headers.get('x-ratelimit-reset');
  }
}

async function fetchJSON(url, signal) {
  const response = await fetch(url, {
    signal,
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) throw new ApiError(response.status, response);
  return response.json();
}

async function fetchUserAndRepos(username, signal) {
  const name = encodeURIComponent(username);
  const [user, repos] = await Promise.all([
    fetchJSON(`${API_BASE}/users/${name}`, signal),
    fetchJSON(`${API_BASE}/users/${name}/repos?per_page=100&sort=updated`, signal),
  ]);
  return { user, repos };
}

function describeError(error, username) {
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return {
        stamp: 'Not filed',
        title: 'User not found.',
        text: `There is no GitHub account called “${username}”. Check the spelling and try again.`,
        retry: false,
      };
    }
    if ((error.status === 403 || error.status === 429) && error.rateLimitRemaining === '0') {
      const reset = error.rateLimitReset
        ? new Date(Number(error.rateLimitReset) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : 'a few minutes';
      return {
        stamp: 'Closed',
        title: 'GitHub request limit reached.',
        text: `Unauthenticated requests are limited to 60 per hour. The limit resets at ${reset}.`,
        retry: true,
      };
    }
    return {
      stamp: 'Error',
      title: 'The request to GitHub failed.',
      text: `GitHub responded with status ${error.status}. Please try again in a moment.`,
      retry: true,
    };
  }
  return {
    stamp: 'Offline',
    title: 'Could not reach GitHub.',
    text: 'Check your internet connection and try again.',
    retry: true,
  };
}

function showLoading(username) {
  els.status.replaceChildren(
    el('div', { className: 'status-box status-box--loading' }, [
      el('p', { className: 'loading-title' }, [
        el('span', { className: 'loader', 'aria-hidden': 'true' }),
        'Loading repositories...',
      ]),
      el('p', { className: 'status-text', text: `Pulling the drawer for @${username}.` }),
    ])
  );
}

function showMessage(type, { stamp, title, text, retry }) {
  const box = el('div', { className: `status-box status-box--${type}` }, [
    stamp ? el('span', { className: 'status-stamp', 'aria-hidden': 'true', text: stamp }) : null,
    el('p', { className: 'status-title', text: title }),
    el('p', { className: 'status-text', text }),
  ]);

  if (retry) {
    box.append(
      el('button', {
        type: 'button',
        className: 'btn btn-ghost',
        text: 'Try again',
        onclick: () => search(els.input.value.trim()),
      })
    );
  }
  els.status.replaceChildren(box);
}

function clearStatus() {
  els.status.replaceChildren();
}

function setBusy(isBusy) {
  els.button.disabled = isBusy;
  els.button.textContent = isBusy ? 'Searching…' : 'Search';
  els.form.setAttribute('aria-busy', String(isBusy));
}

async function search(rawUsername) {
  const username = rawUsername.trim();
  const problem = validateUsername(username);
  if (problem) {
    showFieldError(problem);
    els.input.focus();
    return;
  }
  showFieldError('');

  state.controller?.abort();
  const controller = new AbortController();
  state.controller = controller;

  els.results.hidden = true;
  setBusy(true);
  showLoading(username);

  try {
    const { user, repos } = await fetchUserAndRepos(username, controller.signal);

    state.user = user;
    state.repos = repos;
    state.filter = 'All';
    rememberUser(user.login);

    clearStatus();
    renderProfile(user, repos.length);

    if (repos.length === 0) {
      showMessage('empty', {
        stamp: 'Empty',
        title: 'No repositories found.',
        text: `@${user.login} does not have any public repositories yet.`,
      });
      els.results.hidden = false;
      els.results.querySelector('.toolbar').hidden = true;
      els.grid.replaceChildren();
      els.count.textContent = '';
      return;
    }

    els.results.querySelector('.toolbar').hidden = false;
    updateTabs();
    renderRepos();
    els.results.hidden = false;
  } catch (error) {
    if (error.name === 'AbortError') return;
    console.error(error);
    showMessage('error', describeError(error, username));
  } finally {
    if (state.controller === controller) {
      state.controller = null;
      setBusy(false);
    }
  }
}

function renderProfile(user, loadedCount) {
  const stats = [
    ['Public repos', user.public_repos],
    ['Followers', user.followers],
    ['Following', user.following],
  ].map(([label, value]) =>
    el('li', {}, [el('strong', { text: numberFormat.format(value) }), ` ${label}`])
  );

  if (user.public_repos > loadedCount) {
    stats.push(el('li', { text: `Showing the ${loadedCount} most recently updated` }));
  }

  els.profile.replaceChildren(
    el('img', {
      className: 'profile-avatar',
      src: user.avatar_url,
      alt: `Avatar of ${user.login}`,
      width: 88,
      height: 88,
      loading: 'lazy',
    }),
    el('div', { className: 'profile-body' }, [
      el('h3', { className: 'profile-name', text: user.name || user.login }),
      el('a', {
        className: 'profile-login',
        href: user.html_url,
        target: '_blank',
        rel: 'noopener',
        text: `@${user.login}`,
      }),
      user.bio ? el('p', { className: 'profile-bio', text: user.bio }) : null,
      el('ul', { className: 'profile-stats' }, stats),
    ])
  );
}

function languageBucket(language) {
  return MAIN_LANGUAGES.includes(language) ? language : 'Other';
}

function sortRepos(repos, mode) {
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  const sorted = [...repos];
  switch (mode) {
    case 'stars-asc':
      return sorted.sort((a, b) => a.stargazers_count - b.stargazers_count || byName(a, b));
    case 'name-asc':
      return sorted.sort(byName);
    case 'name-desc':
      return sorted.sort((a, b) => byName(b, a));
    case 'updated-desc':
      return sorted.sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at));
    case 'stars-desc':
    default:
      return sorted.sort((a, b) => b.stargazers_count - a.stargazers_count || byName(a, b));
  }
}

function getVisibleRepos() {
  const filtered =
    state.filter === 'All'
      ? state.repos
      : state.repos.filter((repo) => languageBucket(repo.language) === state.filter);
  return sortRepos(filtered, state.sort);
}

function createRepoCard(repo, index) {
  const bucket = languageBucket(repo.language);
  const shortUrl = repo.html_url.replace(/^https?:\/\//, '');

  const meta = el('dl', { className: 'card-meta' }, [
    el('div', {}, [el('dt', { text: '★ Stars' }), el('dd', { text: numberFormat.format(repo.stargazers_count) })]),
    el('div', {}, [el('dt', { text: 'Forks' }), el('dd', { text: numberFormat.format(repo.forks_count) })]),
    el('div', {}, [el('dt', { text: 'Updated' }), el('dd', { text: dateFormat.format(new Date(repo.pushed_at)) })]),
  ]);

  return el('li', { className: 'repo-card', dataset: { lang: bucket } }, [
    el('span', { className: 'card-no', text: `No. ${String(index + 1).padStart(3, '0')}` }),
    el('div', { className: 'card-head' }, [
      el('h3', { className: 'card-title' }, [
        el('a', { href: repo.html_url, target: '_blank', rel: 'noopener', text: repo.name }),
      ]),
      el('span', { className: 'stamp', text: repo.language || 'Unknown' }),
    ]),
    repo.fork ? el('span', { className: 'card-tag', text: 'Fork' }) : null,
    el('p', {
      className: repo.description ? 'card-desc' : 'card-desc card-desc--empty',
      text: repo.description || 'No description provided.',
    }),
    meta,
    el('a', {
      className: 'card-url',
      href: repo.html_url,
      target: '_blank',
      rel: 'noopener',
      text: shortUrl,
      'aria-label': `Open ${repo.name} on GitHub`,
    }),
  ]);
}

function renderRepos() {
  const visible = getVisibleRepos();

  if (visible.length === 0) {
    els.grid.replaceChildren(
      el('li', {
        className: 'grid-empty',
        text: `No ${state.filter} repositories in this drawer. Try another language.`,
      })
    );
  } else {
    els.grid.replaceChildren(...visible.map(createRepoCard));
  }

  const total = state.repos.length;
  els.count.textContent =
    state.filter === 'All'
      ? `${total} ${total === 1 ? 'card' : 'cards'} in the drawer`
      : `Showing ${visible.length} of ${total} cards · ${state.filter}`;
}

function updateTabs() {
  const counts = { All: state.repos.length };
  for (const repo of state.repos) {
    const bucket = languageBucket(repo.language);
    counts[bucket] = (counts[bucket] || 0) + 1;
  }

  els.tabs.forEach((tab) => {
    const lang = tab.dataset.lang;
    tab.setAttribute('aria-pressed', String(lang === state.filter));
    tab.querySelector('.tab-count').textContent = counts[lang] || 0;
  });
}

function renderHistory() {
  const history = getHistory();
  els.recent.hidden = history.length === 0;
  els.recentList.replaceChildren(
    ...history.map((name) =>
      el('li', {}, [
        el('button', {
          type: 'button',
          className: 'recent-chip',
          text: name,
          onclick: () => {
            els.input.value = name;
            search(name);
          },
        }),
      ])
    )
  );
}

function setupNavigation() {
  const closeMenu = () => {
    els.nav.classList.remove('is-open');
    els.navToggle.setAttribute('aria-expanded', 'false');
  };

  els.navToggle.addEventListener('click', () => {
    const open = els.nav.classList.toggle('is-open');
    els.navToggle.setAttribute('aria-expanded', String(open));
  });

  els.navLinks.forEach((link) => {
    link.addEventListener('click', () => {
      closeMenu();
      if (link.hash === '#search') {
        setTimeout(() => els.input.focus({ preventScroll: true }), 300);
      }
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu();
  });

  const sections = [...els.navLinks].map((link) => document.querySelector(link.hash));
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        els.navLinks.forEach((link) => {
          if (link.hash === `#${entry.target.id}`) link.setAttribute('aria-current', 'true');
          else link.removeAttribute('aria-current');
        });
      });
    },
    { rootMargin: '-45% 0px -50% 0px' }
  );
  sections.forEach((section) => section && observer.observe(section));
}

els.form.addEventListener('submit', (event) => {
  event.preventDefault();
  search(els.input.value);
});

els.input.addEventListener('input', () => {
  if (!els.error.hidden) showFieldError(validateUsername(els.input.value.trim()));
});

els.tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    state.filter = tab.dataset.lang;
    updateTabs();
    renderRepos();
  });
});

els.sort.addEventListener('change', () => {
  state.sort = els.sort.value;
  storage.set(STORAGE_SORT, state.sort);
  renderRepos();
});

function init() {
  els.year.textContent = new Date().getFullYear();
  setupNavigation();
  renderHistory();

  const savedSort = storage.get(STORAGE_SORT);
  if (savedSort && els.sort.querySelector(`option[value="${savedSort}"]`)) {
    state.sort = savedSort;
    els.sort.value = savedSort;
  }

  const lastUser = new URLSearchParams(location.search).get('user') || storage.get(STORAGE_USER);
  if (lastUser) {
    els.input.value = lastUser;
    search(lastUser);
  } else {
    showMessage('info', {
      title: 'The drawer is empty.',
      text: 'Enter a GitHub username above to file their public repositories here.',
    });
  }
}

init();
