(function () {
  const LOGIN_REDIRECT = 'alunos.html';
  const LEGACY_USER = {
    id: 'LEGACY-OPEN-ACCESS',
    nome: 'Modo local',
    username: 'legacy',
    role: 'admin',
    ativo: true,
    isChief: false,
  };

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async function request(path, options) {
    const config = Object.assign({
      headers: {},
      credentials: 'same-origin',
    }, options || {});

    if (config.body && typeof config.body === 'object' && !(config.body instanceof FormData)) {
      config.headers['Content-Type'] = 'application/json';
      config.body = JSON.stringify(config.body);
    }

    const response = await fetch(path, config);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || 'Falha na comunicação com o servidor.');
    }
    return data;
  }

  function getNextPage() {
    const params = new URLSearchParams(window.location.search);
    const next = params.get('next');
    return next && /^[a-z0-9_.-]+\.html$/i.test(next) ? next : LOGIN_REDIRECT;
  }

  function injectSharedStyles() {
    if (document.getElementById('futpass-auth-styles')) return;

    const style = document.createElement('style');
    style.id = 'futpass-auth-styles';
    style.textContent = `
      .auth-session-bar {
        position: fixed;
        top: 18px;
        right: 18px;
        z-index: 999;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 14px;
        border-radius: 999px;
        background: rgba(15, 23, 42, 0.92);
        color: #e2e8f0;
        box-shadow: 0 18px 36px rgba(15, 23, 42, 0.24);
        backdrop-filter: blur(8px);
      }

      .auth-session-meta strong {
        display: block;
        font-size: 0.92rem;
      }

      .auth-session-meta span {
        display: block;
        font-size: 0.72rem;
        color: #94a3b8;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }

      .auth-session-button {
        border: none;
        border-radius: 999px;
        padding: 9px 14px;
        background: #ef4444;
        color: #fff;
        cursor: pointer;
        font-weight: 600;
      }

      .auth-session-button:hover {
        background: #dc2626;
      }

      .sidebar .admin-link-badge {
        margin-left: 8px;
        font-size: 0.72rem;
        color: #fbbf24;
      }

      .auth-session-bar.inline {
        position: relative;
        top: 0;
        right: 0;
        margin: 0 0 20px auto;
        background: rgba(15, 23, 42, 0.96);
      }

      @media (max-width: 900px) {
        .auth-session-bar {
          position: static;
          margin: 16px;
          border-radius: 18px;
          justify-content: space-between;
        }

        .auth-session-bar.inline {
          width: auto;
          margin: 0 16px 16px;
        }
      }
    `;

    document.head.appendChild(style);
  }

  function mountSessionBar(user) {
    injectSharedStyles();

    let bar = document.getElementById('auth-session-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'auth-session-bar';
      bar.className = 'auth-session-bar';
    }

    const targetContainer = document.querySelector('.main-content') || document.querySelector('.page-shell') || document.body;
    if (targetContainer !== document.body) {
      bar.classList.add('inline');
    } else {
      bar.classList.remove('inline');
    }

    if (!bar.parentNode || bar.parentNode !== targetContainer) {
      targetContainer.insertBefore(bar, targetContainer.firstChild);
    }

    const roleLabel = user.isChief ? 'Administrador-chefe' : (user.role === 'admin' ? 'Administrador' : 'Operador');

    // Limpa conteúdo atual e monta elementos de forma segura
    bar.innerHTML = '';

    const meta = document.createElement('div');
    meta.className = 'auth-session-meta';
    const nameStrong = document.createElement('strong');
    nameStrong.textContent = user.nome || '';
    const roleSpan = document.createElement('span');
    roleSpan.textContent = roleLabel;
    meta.appendChild(nameStrong);
    meta.appendChild(roleSpan);

    const logoutBtn = document.createElement('button');
    logoutBtn.type = 'button';
    logoutBtn.className = 'auth-session-button';
    logoutBtn.id = 'auth-logout-button';
    logoutBtn.textContent = 'Sair';
    logoutBtn.addEventListener('click', async () => { await apiLogout(); });

    bar.appendChild(meta);
    bar.appendChild(logoutBtn);
  }

  function injectAdminLink(user) {
    if (!user || !user.isChief) return;

    const navList = document.querySelector('.sidebar nav ul');
    const sidebar = navList || document.querySelector('.sidebar');
    if (!sidebar) return;

    if (sidebar.querySelector('a[href="users.html"]') || sidebar.querySelector('li a[href="users.html"]')) return;

    const isUsersPage = window.location.pathname.endsWith('/users.html') || window.location.pathname.endsWith('users.html');
    const link = document.createElement('a');
    link.href = 'users.html';
    link.className = isUsersPage ? 'menu-item active' : 'menu-item';
    link.appendChild(document.createTextNode('Acessos '));
    const badge = document.createElement('span');
    badge.className = 'admin-link-badge';
    badge.textContent = 'Master';
    link.appendChild(badge);

    if (navList) {
      const item = document.createElement('li');
      item.appendChild(link);
      navList.appendChild(item);
    } else if (sidebar.tagName === 'ASIDE' || sidebar.tagName === 'DIV' || sidebar.tagName === 'NAV') {
      sidebar.appendChild(link);
    } else {
      sidebar.appendChild(link);
    }
  }

  async function getStatus() {
    try {
      const status = await request('/api/auth/status');
      return Object.assign({ serverAvailable: true }, status);
    } catch (error) {
      return {
        authenticated: false,
        setupRequired: true,
        user: null,
        serverAvailable: false,
        error: error.message,
      };
    }
  }

  async function requireAuthPage(options) {
    const config = Object.assign({ requireAdmin: false, requireChief: false }, options || {});
    const status = await getStatus();

    if (!status.serverAvailable || status.setupRequired) {
      return LEGACY_USER;
    }

    if (!status.authenticated) {
      const currentPage = window.location.pathname.split('/').pop() || LOGIN_REDIRECT;
      window.location.href = `index.html?next=${encodeURIComponent(currentPage)}`;
      return null;
    }

    if (config.requireChief && !status.user.isChief) {
      window.location.href = 'alunos.html';
      return null;
    }

    if (config.requireAdmin && status.user.role !== 'admin') {
      window.location.href = 'alunos.html';
      return null;
    }

    mountSessionBar(status.user);
    injectAdminLink(status.user);
    return status.user;
  }

  async function apiLogout() {
    try {
      await request('/api/auth/logout', { method: 'POST' });
    } finally {
      window.location.href = 'index.html';
    }
  }

  function setPortalMessage(message, type) {
    const box = document.getElementById('auth-feedback');
    if (!box) return;
    box.textContent = message || '';
    box.className = `auth-feedback ${type || ''}`.trim();
  }

  function togglePortalView(status) {
    const setupCard = document.getElementById('setup-card');
    const loginCard = document.getElementById('login-card');
    const readyCard = document.getElementById('ready-card');

    if (setupCard) setupCard.hidden = !status.setupRequired;
    if (loginCard) loginCard.hidden = status.setupRequired || status.authenticated;
    if (readyCard) readyCard.hidden = !status.authenticated;

    if (status.authenticated && readyCard) {
      const title = readyCard.querySelector('[data-auth-name]');
      const role = readyCard.querySelector('[data-auth-role]');
      if (title) title.textContent = status.user.nome;
      if (role) role.textContent = status.user.isChief ? 'Administrador-chefe conectado' : 'Sessão ativa';
    }
  }

  async function initPortal() {
    const status = await getStatus();

    if (!status.serverAvailable) {
      togglePortalView({ authenticated: true, setupRequired: false, user: LEGACY_USER });
      setPortalMessage('Servidor indisponível. O sistema está operando em modo local neste navegador.', 'info');
      return;
    }

    togglePortalView(status);

    const setupForm = document.getElementById('setup-form');
    const loginForm = document.getElementById('login-form');
    const continueButton = document.getElementById('continue-button');
    const logoutButton = document.getElementById('logout-portal-button');

    if (setupForm) {
      setupForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const formData = new FormData(setupForm);
        const password = String(formData.get('password') || '');
        const confirmPassword = String(formData.get('confirmPassword') || '');

        if (password !== confirmPassword) {
          setPortalMessage('As senhas não conferem.', 'error');
          return;
        }

        try {
          setPortalMessage('Configurando acesso principal...', 'info');
          await request('/api/auth/setup', {
            method: 'POST',
            body: {
              nome: formData.get('nome'),
              username: formData.get('username'),
              password,
            },
          });
          window.location.href = getNextPage();
        } catch (error) {
          setPortalMessage(error.message, 'error');
        }
      });
    }

    if (loginForm) {
      loginForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const formData = new FormData(loginForm);
        try {
          setPortalMessage('Validando acesso...', 'info');
          await request('/api/auth/login', {
            method: 'POST',
            body: {
              username: formData.get('username'),
              password: formData.get('password'),
            },
          });
          window.location.href = getNextPage();
        } catch (error) {
          setPortalMessage(error.message, 'error');
        }
      });
    }

    if (continueButton) {
      continueButton.addEventListener('click', () => {
        window.location.href = getNextPage();
      });
    }

    if (logoutButton) {
      logoutButton.addEventListener('click', async () => {
        await apiLogout();
      });
    }
  }

  window.FutPassAuth = {
    escapeHtml,
    getStatus,
    request,
    requireAuthPage,
    initPortal,
    logout: apiLogout,
  };
})();