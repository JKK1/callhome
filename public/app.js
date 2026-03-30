'use strict';
// ═══════════════════════════════════════════════════════════════════════════════
// Calling Home — client-side logic
// All encryption/decryption happens here; the server only ever sees ciphertext.
// ═══════════════════════════════════════════════════════════════════════════════

// ── Utilities ─────────────────────────────────────────────────────────────────

function toBase64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function fromBase64(str) {
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function el(id) { return document.getElementById(id); }

function formatDate(iso) {
  try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return iso; }
}

// ── E2E Crypto ────────────────────────────────────────────────────────────────

const PBKDF2_ITERATIONS = 200_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

async function importPassword(password) {
  return crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey', 'deriveBits']);
}

async function deriveEncryptionKey(password, salt) {
  const km = await importPassword(password);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: typeof salt === 'string' ? fromBase64(salt) : salt,
      iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

async function deriveVerifier(password, slug) {
  const km = await importPassword(password);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(`calling-home:verify:${slug}`),
      iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    km, 256,
  );
  return toBase64(bits);
}

async function encryptContacts(password, contacts) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv   = crypto.getRandomValues(new Uint8Array(12));
  const key  = await deriveEncryptionKey(password, salt);
  const ct   = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key,
    enc.encode(JSON.stringify({ contacts })),
  );
  return { salt: toBase64(salt), iv: toBase64(iv), data: toBase64(ct) };
}

async function decryptContacts(password, { salt, iv, data }) {
  const key = await deriveEncryptionKey(password, salt);
  const pt  = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(iv) }, key, fromBase64(data),
  );
  const parsed = JSON.parse(dec.decode(pt));
  // Support both old single-contact format and new multi-contact format
  if (Array.isArray(parsed.contacts)) return parsed.contacts;
  return [parsed]; // legacy single contact
}

// ── API ───────────────────────────────────────────────────────────────────────

async function apiFetch(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res  = await fetch(path, opts);
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data: json };
}

const checkSlug  = slug => apiFetch('GET', `/api/contacts/check?slug=${encodeURIComponent(slug)}`);
const apiCreate  = body => apiFetch('POST', '/api/contacts', body);
const apiRead    = slug => apiFetch('GET',  `/api/contacts/${encodeURIComponent(slug)}`);
const apiUpdate  = (slug, body) => apiFetch('PUT',    `/api/contacts/${encodeURIComponent(slug)}`, body);
const apiDelete  = (slug, body) => apiFetch('DELETE', `/api/contacts/${encodeURIComponent(slug)}`, body);

// ── Slug validation ───────────────────────────────────────────────────────────

const SLUG_RE = /^[a-z0-9][a-z0-9\-_]{1,48}[a-z0-9]$/;

function validateSlug(slug) {
  if (!slug) return 'Choose a custom URL.';
  if (!SLUG_RE.test(slug.toLowerCase())) return 'Letters, numbers, hyphens, underscores. Min 3 chars.';
  return null;
}

// ── SPA Router ────────────────────────────────────────────────────────────────

const STATIC_ROUTES = new Set(['about', 'privacy', 'terms']);

function getRoute() {
  const p = window.location.pathname.replace(/^\/|\/$/g, '');
  if (!p || p === 'index.html') return { page: 'home' };
  if (STATIC_ROUTES.has(p))     return { page: p };
  return { page: 'view', slug: p };
}

function navigate(path) {
  window.history.pushState(null, '', path);
  route();
}

function route() {
  const { page, slug } = getRoute();
  const app = el('app');
  app.className = '';
  switch (page) {
    case 'home':    renderCreatePage(); break;
    case 'about':   app.className = 'wide'; renderAboutPage();   break;
    case 'privacy': app.className = 'wide'; renderPrivacyPage(); break;
    case 'terms':   app.className = 'wide'; renderTermsPage();   break;
    case 'view':    renderViewPage(slug); break;
  }
  window.scrollTo(0, 0);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONTACT FORM SECTIONS (shared by create + update)
// ═══════════════════════════════════════════════════════════════════════════════

function contactSectionHTML(index, contact = {}) {
  const phones = contact.phones?.length ? contact.phones : [''];
  const emails = contact.emails?.length ? contact.emails : [''];
  return `
    <div class="contact-section" data-index="${index}">
      <div class="contact-section-header">
        <span class="contact-section-title">Contact ${index + 1}</span>
        ${index > 0 ? `<button type="button" class="remove-contact-btn" data-index="${index}">Remove</button>` : ''}
      </div>

      <div class="field">
        <label>Name</label>
        <input type="text" class="c-name" placeholder="Full name" value="${escHtml(contact.name || '')}" />
      </div>

      <div class="field">
        <label>Phone numbers</label>
        <div class="multi-field c-phones">
          ${phones.map(p => `<div class="input-row"><input type="tel" value="${escHtml(p)}" placeholder="+1 555 000 0000" /></div>`).join('')}
        </div>
        <button type="button" class="add-btn add-phone-btn">+ Add phone</button>
      </div>

      <div class="field">
        <label>Email addresses</label>
        <div class="multi-field c-emails">
          ${emails.map(e => `<div class="input-row"><input type="email" value="${escHtml(e)}" placeholder="you@example.com" /></div>`).join('')}
        </div>
        <button type="button" class="add-btn add-email-btn">+ Add email</button>
      </div>

      <div class="field">
        <label>Address <span class="optional">(optional)</span></label>
        <textarea class="c-address" rows="2" placeholder="123 Main St, City, Country">${escHtml(contact.address || '')}</textarea>
      </div>

      <div class="field">
        <label>Notes <span class="optional">(optional, max 256 chars)</span></label>
        <textarea class="c-notes" rows="2" maxlength="256" placeholder="e.g. My work phone">${escHtml(contact.notes || '')}</textarea>
        <p class="char-count">${(contact.notes || '').length} / 256</p>
      </div>
    </div>
  `;
}

function wireContactSections(container) {
  // Notes char counters
  container.querySelectorAll('.c-notes').forEach(ta => {
    const counter = ta.nextElementSibling;
    ta.addEventListener('input', () => {
      const n = ta.value.length;
      counter.textContent = `${n} / 256`;
      counter.className = n > 240 ? 'char-count warn' : 'char-count';
    });
  });

  // Add phone / add email buttons
  container.querySelectorAll('.add-phone-btn').forEach(btn => {
    btn.addEventListener('click', () => addInputRow(btn.previousElementSibling, 'tel', '+1 555 000 0000', 5));
  });
  container.querySelectorAll('.add-email-btn').forEach(btn => {
    btn.addEventListener('click', () => addInputRow(btn.previousElementSibling, 'email', 'you@example.com', 3));
  });
}

function addInputRow(list, type, placeholder, max) {
  if (list.querySelectorAll('.input-row').length >= max) return;
  const row = document.createElement('div');
  row.className = 'input-row';
  const inp = document.createElement('input');
  inp.type = type; inp.placeholder = placeholder;
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button'; removeBtn.className = 'remove-btn';
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', () => { row.remove(); });
  row.appendChild(inp); row.appendChild(removeBtn);
  list.appendChild(row);
  inp.focus();
}

function readContactSection(section) {
  const getVals = cls => [...section.querySelectorAll(`.${cls} .input-row input`)]
    .map(i => i.value.trim()).filter(Boolean);
  return {
    name:    section.querySelector('.c-name').value.trim(),
    phones:  getVals('c-phones'),
    emails:  getVals('c-emails'),
    address: section.querySelector('.c-address').value.trim(),
    notes:   section.querySelector('.c-notes').value.trim().slice(0, 256),
  };
}

function readAllContacts(container) {
  return [...container.querySelectorAll('.contact-section')].map(readContactSection);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CREATE PAGE
// ═══════════════════════════════════════════════════════════════════════════════

function renderCreatePage() {
  el('app').innerHTML = `
    <div class="card">
      <h1 class="card-title">Create a contact page</h1>
      <p class="card-subtitle">
        Choose a URL, set a password, and add the contacts people should reach
        if you lose your phone. Everything is encrypted in your browser.
      </p>

      <div id="form-alert"></div>

      <p class="section-label">URL</p>
      <div class="field">
        <div class="slug-row">
          <span class="slug-prefix" id="slug-prefix">calling-home.com/</span>
          <input type="text" id="slug" placeholder="your-name" maxlength="50"
            autocomplete="off" spellcheck="false" autocapitalize="none" />
          <span class="slug-status" id="slug-status"></span>
        </div>
        <p class="hint">Letters, numbers, hyphens, underscores. Min 3 characters.</p>
      </div>

      <p class="section-label">Password</p>
      <div class="field">
        <input type="password" id="password" placeholder="Choose a password (min 8 chars)"
          autocomplete="new-password" />
      </div>
      <div class="field">
        <input type="password" id="password2" placeholder="Confirm password"
          autocomplete="new-password" />
      </div>

      <p class="section-label">Contacts</p>
      <div id="contacts-container">
        ${contactSectionHTML(0)}
      </div>
      <button type="button" class="add-btn" id="add-contact-btn" style="margin-top:.5rem">+ Add another contact</button>

      <div class="btn-row">
        <button type="button" class="btn btn-primary" id="create-btn">Create page</button>
      </div>
    </div>
  `;

  const prefix = el('slug-prefix');
  if (prefix) prefix.textContent = `${window.location.hostname}/`;

  const container = el('contacts-container');
  wireContactSections(container);
  wireRemoveContacts(container);

  // Slug availability check
  let slugTimer = null;
  el('slug').addEventListener('input', () => {
    const val = el('slug').value.trim().toLowerCase();
    const status = el('slug-status');
    status.textContent = ''; status.className = 'slug-status';
    clearTimeout(slugTimer);
    if (!val) return;
    const e = validateSlug(val);
    if (e) { status.textContent = '✗'; status.className = 'slug-status taken'; return; }
    status.textContent = '…'; status.className = 'slug-status checking';
    slugTimer = setTimeout(async () => {
      const res = await checkSlug(val).catch(() => null);
      if (!res) return;
      status.textContent = res.data?.available ? '✓' : '✗';
      status.className   = `slug-status ${res.data?.available ? 'ok' : 'taken'}`;
    }, 400);
  });

  // Add contact
  el('add-contact-btn').addEventListener('click', () => {
    const sections = container.querySelectorAll('.contact-section');
    if (sections.length >= 10) return;
    const div = document.createElement('div');
    div.innerHTML = contactSectionHTML(sections.length);
    const section = div.firstElementChild;
    container.appendChild(section);
    wireContactSections(section);
    wireRemoveContacts(container);
    section.querySelector('.c-name')?.focus();
  });

  el('create-btn').addEventListener('click', handleCreateSubmit);
}

function wireRemoveContacts(container) {
  container.querySelectorAll('.remove-contact-btn').forEach(btn => {
    btn.onclick = () => {
      btn.closest('.contact-section').remove();
      // Re-number titles
      container.querySelectorAll('.contact-section').forEach((s, i) => {
        s.dataset.index = i;
        s.querySelector('.contact-section-title').textContent = `Contact ${i + 1}`;
        const rb = s.querySelector('.remove-contact-btn');
        if (rb) rb.dataset.index = i;
        if (i === 0 && rb) rb.remove();
      });
    };
  });
}

function showFormAlert(msg, type = 'error') {
  el('form-alert').innerHTML = msg
    ? `<div class="alert alert-${type}">${escHtml(msg)}</div>` : '';
}

async function handleCreateSubmit() {
  const btn = el('create-btn');
  btn.disabled = true; btn.textContent = 'Encrypting…';
  showFormAlert('');

  try {
    const slug     = el('slug').value.trim().toLowerCase();
    const password = el('password').value;
    const pass2    = el('password2').value;
    const contacts = readAllContacts(el('contacts-container'));

    const slugErr = validateSlug(slug);
    if (slugErr) { showFormAlert(slugErr); return; }
    if (!password) { showFormAlert('Password is required.'); return; }
    if (password !== pass2) { showFormAlert('Passwords do not match.'); return; }
    if (password.length < 8) { showFormAlert('Password must be at least 8 characters.'); return; }
    if (contacts.every(c => !c.name && !c.phones.length && !c.emails.length)) {
      showFormAlert('Add at least one name, phone, or email.'); return;
    }

    const encrypted = await encryptContacts(password, contacts);
    const verifier  = await deriveVerifier(password, slug);

    btn.textContent = 'Creating…';
    const { ok, status, data } = await apiCreate({ slug, ...encrypted, verifier });

    if (ok) {
      renderSuccessPage(slug);
    } else if (status === 202) {
      renderQueuedPage(slug, data.position);
    } else {
      showFormAlert(data.error || `Error ${status}.`);
    }
  } catch (e) {
    console.error(e);
    showFormAlert('Something went wrong. Please try again.');
  } finally {
    btn.disabled = false; btn.textContent = 'Create page';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUCCESS / QUEUED PAGES
// ═══════════════════════════════════════════════════════════════════════════════

function renderSuccessPage(slug) {
  const url = `${window.location.origin}/${slug}`;
  el('app').innerHTML = `
    <div class="card">
      <h1 class="card-title">Page created</h1>
      <p class="card-subtitle">Share this URL with people who may need to reach you.</p>

      <div class="url-box">
        <span class="url-text">${escHtml(url)}</span>
        <button class="copy-btn" id="copy-btn">Copy</button>
      </div>

      <div class="alert alert-info">
        Keep your password safe — without it the data cannot be recovered.
      </div>

      <div class="btn-row">
        <a href="/${escHtml(slug)}" class="btn btn-primary">View page</a>
        <a href="/" class="btn btn-secondary">Create another</a>
      </div>
    </div>
  `;
  el('copy-btn').addEventListener('click', async () => {
    await navigator.clipboard.writeText(url).catch(() => {});
    el('copy-btn').textContent = 'Copied!';
    setTimeout(() => { el('copy-btn').textContent = 'Copy'; }, 2000);
  });
}

function renderQueuedPage(slug, initialPosition) {
  el('app').innerHTML = `
    <div class="card">
      <h1 class="card-title">You're in the queue</h1>
      <p class="card-subtitle">
        The service is at capacity. Your page will go live automatically
        as soon as a slot opens up — no action needed.
      </p>
      <div class="alert alert-info" id="queue-status">
        Queue position: <strong id="queue-pos">#${escHtml(String(initialPosition))}</strong>
        &nbsp;<span id="queue-spinner" style="color:var(--gray-400);font-size:.85rem">· checking…</span>
      </div>
      <p class="hint" style="margin-top:.5rem">
        Your URL <strong>/${escHtml(slug)}</strong> is reserved.
        This page refreshes automatically.
      </p>
      <div class="btn-row">
        <a href="/" class="btn btn-secondary">Back to home</a>
      </div>
    </div>
  `;

  let pollInterval = null;

  async function pollQueue() {
    try {
      const { ok, data } = await apiFetch('GET', `/api/queue/${encodeURIComponent(slug)}`);
      if (!ok) return;

      if (data.status === 'ready') {
        clearInterval(pollInterval);
        el('app').innerHTML = `
          <div class="card">
            <h1 class="card-title">Your page is live!</h1>
            <p class="card-subtitle">/${escHtml(slug)} is ready.</p>
            <div class="url-box">
              <span class="url-text">${escHtml(window.location.origin + '/' + slug)}</span>
              <button class="copy-btn" id="copy-btn">Copy</button>
            </div>
            <div class="alert alert-info">Keep your password safe — it cannot be recovered.</div>
            <div class="btn-row">
              <a href="/${escHtml(slug)}" class="btn btn-primary">View page</a>
              <a href="/" class="btn btn-secondary">Create another</a>
            </div>
          </div>
        `;
        el('copy-btn')?.addEventListener('click', async () => {
          await navigator.clipboard.writeText(window.location.origin + '/' + slug).catch(() => {});
          el('copy-btn').textContent = 'Copied!';
          setTimeout(() => { el('copy-btn').textContent = 'Copy'; }, 2000);
        });
        return;
      }

      if (data.status === 'queued' && data.position) {
        const posEl = el('queue-pos');
        if (posEl) posEl.textContent = `#${data.position}`;
        const spinner = el('queue-spinner');
        if (spinner) spinner.textContent = `· updated ${new Date().toLocaleTimeString()}`;
      }
    } catch { /* ignore network errors, keep polling */ }
  }

  // Poll immediately then every 5 seconds
  pollQueue();
  pollInterval = setInterval(pollQueue, 5000);
}

// ═══════════════════════════════════════════════════════════════════════════════
// VIEW PAGE
// ═══════════════════════════════════════════════════════════════════════════════

function renderViewPage(slug) {
  el('app').innerHTML = `
    <div class="card">
      <div class="lock-screen">
        <span class="lock-big">🔒</span>
        <h1>${escHtml(slug)}</h1>
        <p>Enter the password to view this contact page.</p>
      </div>

      <div id="view-alert"></div>

      <div class="field">
        <input type="password" id="view-password" placeholder="Password"
          autocomplete="current-password" />
      </div>
      <div class="btn-row">
        <button type="button" class="btn btn-primary btn-full" id="view-btn">Unlock</button>
      </div>
    </div>
  `;

  const pwdInput = el('view-password');
  const viewBtn  = el('view-btn');

  async function tryUnlock() {
    const password = pwdInput.value;
    if (!password) return;
    viewBtn.disabled = true; viewBtn.textContent = 'Decrypting…';
    el('view-alert').innerHTML = '';

    try {
      const { ok, status, data } = await apiRead(slug);
      if (!ok) {
        showViewAlert(status === 404 ? 'Page not found.' : (data.error || `Error ${status}`));
        return;
      }
      let contacts;
      try { contacts = await decryptContacts(password, data); }
      catch { showViewAlert('Wrong password.'); pwdInput.select(); return; }
      renderContactCards(slug, contacts, password, data.updatedAt);
    } catch { showViewAlert('Network error. Please try again.'); }
    finally { viewBtn.disabled = false; viewBtn.textContent = 'Unlock'; }
  }

  viewBtn.addEventListener('click', tryUnlock);
  pwdInput.addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlock(); });
  setTimeout(() => pwdInput.focus(), 50);
}

function showViewAlert(msg) {
  el('view-alert').innerHTML = msg
    ? `<div class="alert alert-error">${escHtml(msg)}</div>` : '';
}

// ── Contact cards ─────────────────────────────────────────────────────────────

function renderContactCards(slug, contacts, password, updatedAt) {
  const cardsHtml = contacts.map((c, i) => {
    const phones = (c.phones || []).map(p =>
      `<li><span class="detail-icon">📞</span><a class="detail-link" href="tel:${escHtml(p)}">${escHtml(p)}</a></li>`
    ).join('');
    const emails = (c.emails || []).map(e =>
      `<li><span class="detail-icon">✉️</span><a class="detail-link" href="mailto:${escHtml(e)}">${escHtml(e)}</a></li>`
    ).join('');
    const address = c.address
      ? `<li><span class="detail-icon">📍</span><span class="detail-text">${escHtml(c.address)}</span></li>` : '';
    const notes = c.notes
      ? `<li><span class="detail-icon">📝</span><span class="detail-text">${escHtml(c.notes)}</span></li>` : '';
    return `
      <div class="card${i > 0 ? ' contact-card-extra' : ''}">
        ${c.name ? `<div class="contact-name">${escHtml(c.name)}</div>` : ''}
        ${phones || emails || address || notes
          ? `<ul class="contact-detail-list">${phones}${emails}${address}${notes}</ul>`
          : '<p style="color:var(--gray-400);font-size:.9rem">No details.</p>'}
      </div>
    `;
  }).join('');

  el('app').innerHTML = `
    ${cardsHtml}
    <div class="card" style="margin-top:1.25rem">
      ${updatedAt ? `<p class="updated-at">Last updated: ${escHtml(formatDate(updatedAt))}</p>` : ''}
      <div class="btn-row">
        <button type="button" class="btn btn-secondary" id="update-btn">Edit</button>
        <button type="button" class="btn btn-danger btn-sm" id="delete-btn">Delete page</button>
      </div>
    </div>
  `;

  el('update-btn').addEventListener('click', () => renderUpdateForm(slug, password, contacts));
  el('delete-btn').addEventListener('click', () => confirmDelete(slug, password));
}

// ═══════════════════════════════════════════════════════════════════════════════
// UPDATE FORM
// ═══════════════════════════════════════════════════════════════════════════════

function renderUpdateForm(slug, password, existing) {
  const sectionsHtml = existing.map((c, i) => contactSectionHTML(i, c)).join('');

  el('app').innerHTML = `
    <div class="card">
      <h1 class="card-title">Edit page</h1>
      <p class="card-subtitle">/${escHtml(slug)}</p>

      <div id="update-alert"></div>

      <p class="section-label">Contacts</p>
      <div id="update-contacts-container">
        ${sectionsHtml}
      </div>
      <button type="button" class="add-btn" id="u-add-contact" style="margin-top:.5rem">+ Add another contact</button>

      <p class="section-label" style="margin-top:1.5rem">Change password <span class="optional">(leave blank to keep current)</span></p>
      <div class="field">
        <input type="password" id="u-newpass" placeholder="New password" autocomplete="new-password" />
      </div>
      <div class="field">
        <input type="password" id="u-newpass2" placeholder="Confirm new password" autocomplete="new-password" />
      </div>

      <div class="btn-row">
        <button type="button" class="btn btn-primary" id="save-btn">Save</button>
        <button type="button" class="btn btn-secondary" id="cancel-btn">Cancel</button>
      </div>
    </div>
  `;

  const container = el('update-contacts-container');
  wireContactSections(container);
  wireRemoveContacts(container);

  el('u-add-contact').addEventListener('click', () => {
    const sections = container.querySelectorAll('.contact-section');
    if (sections.length >= 10) return;
    const div = document.createElement('div');
    div.innerHTML = contactSectionHTML(sections.length);
    const section = div.firstElementChild;
    container.appendChild(section);
    wireContactSections(section);
    wireRemoveContacts(container);
    section.querySelector('.c-name')?.focus();
  });

  el('cancel-btn').addEventListener('click', () => renderContactCards(slug, existing, password, null));
  el('save-btn').addEventListener('click', () => handleSaveUpdate(slug, password));
}

async function handleSaveUpdate(slug, currentPassword) {
  const btn = el('save-btn');
  btn.disabled = true; btn.textContent = 'Saving…';
  el('update-alert').innerHTML = '';

  try {
    const contacts  = readAllContacts(el('update-contacts-container'));
    const newPass   = el('u-newpass').value;
    const newPass2  = el('u-newpass2').value;

    if (newPass && newPass !== newPass2) {
      el('update-alert').innerHTML = `<div class="alert alert-error">Passwords do not match.</div>`; return;
    }
    if (newPass && newPass.length < 8) {
      el('update-alert').innerHTML = `<div class="alert alert-error">Password must be at least 8 characters.</div>`; return;
    }

    const savePassword = newPass || currentPassword;
    const encrypted    = await encryptContacts(savePassword, contacts);
    const verifier     = await deriveVerifier(currentPassword, slug);
    const payload      = { verifier, ...encrypted };
    if (newPass) payload.newVerifier = await deriveVerifier(newPass, slug);

    const { ok, status, data } = await apiUpdate(slug, payload);
    if (ok) {
      renderContactCards(slug, contacts, savePassword, new Date().toISOString());
    } else {
      el('update-alert').innerHTML = `<div class="alert alert-error">${escHtml(data.error || `Error ${status}`)}</div>`;
    }
  } catch (e) {
    console.error(e);
    el('update-alert').innerHTML = `<div class="alert alert-error">Something went wrong.</div>`;
  } finally {
    btn.disabled = false; btn.textContent = 'Save';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DELETE
// ═══════════════════════════════════════════════════════════════════════════════

async function confirmDelete(slug, password) {
  if (!confirm(`Delete /${slug}? This cannot be undone.`)) return;
  try {
    const verifier = await deriveVerifier(password, slug);
    const { ok, data } = await apiDelete(slug, { verifier });
    if (ok) {
      el('app').innerHTML = `
        <div class="card" style="text-align:center;padding:2rem">
          <p style="font-size:2rem;margin-bottom:.75rem">🗑️</p>
          <h2 style="margin-bottom:.5rem">Deleted</h2>
          <p style="color:var(--gray-600);margin-bottom:1.5rem">/${escHtml(slug)} has been removed.</p>
          <a href="/" class="btn btn-primary">Create a new page</a>
        </div>
      `;
    } else { alert(data.error || 'Delete failed.'); }
  } catch { alert('Network error. Please try again.'); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATIC PAGES
// ═══════════════════════════════════════════════════════════════════════════════

function renderAboutPage() {
  el('app').innerHTML = `
    <div class="static-page">
      <div class="page-hero">
        <h1>About Calling Home</h1>
        <p class="lead">A free, encrypted contact page for when you lose your phone.</p>
      </div>

      <h2>What it does</h2>
      <p>
        Create a URL on calling-home.com, add the contact details of people others can reach
        on your behalf, set a password, and share the link. If your phone is ever lost or stolen,
        anyone with the link and password can find those contacts.
      </p>
      <p>
        You can add multiple contacts per page — useful for listing a partner, family member,
        or colleague alongside yourself.
      </p>

      <h2>How encryption works</h2>
      <ol class="how-it-works">
        <li><div><strong>You enter a password and contact details</strong><br>Nothing is sent to the server yet.</div></li>
        <li><div><strong>Your browser encrypts the data</strong><br>AES-256-GCM encryption using a key derived from your password via PBKDF2 (200,000 iterations, SHA-256). The server never receives your password or plaintext data.</div></li>
        <li><div><strong>Only the encrypted blob is stored</strong><br>The server holds ciphertext, a salt, an IV, and a write-auth verifier (also derived from your password, but separately — it cannot decrypt the data).</div></li>
        <li><div><strong>Decryption happens in the browser</strong><br>When someone visits your page and enters the password, their browser fetches the blob and decrypts it locally. A wrong password causes decryption to fail — nothing is revealed.</div></li>
      </ol>

      <div class="oss-banner">
        <h2>Open source</h2>
        <p>No ads, no tracking, no monetisation. The full source is public.</p>
        <a href="https://github.com/jkk1/callhome" target="_blank" rel="noopener" class="btn">View on GitHub</a>
      </div>
    </div>
  `;
}

function renderPrivacyPage() {
  el('app').innerHTML = `
    <div class="static-page">
      <div class="page-hero">
        <h1>Privacy</h1>
        <p class="lead">We are designed to know as little about you as possible.</p>
      </div>

      <h2>What the server stores</h2>
      <ul>
        <li><strong>Encrypted contact data</strong> — AES-256-GCM ciphertext. We cannot read it.</li>
        <li><strong>Salt &amp; IV</strong> — needed for decryption, contain no personal information.</li>
        <li><strong>Write verifier</strong> — a PBKDF2 hash used to authenticate updates. Not your password; cannot decrypt data.</li>
        <li><strong>Timestamps</strong> — when the page was created and last updated.</li>
      </ul>

      <h2>What we never see</h2>
      <ul>
        <li>Your contact details in plaintext.</li>
        <li>Your password.</li>
        <li>Who views your page.</li>
      </ul>

      <h2>Cookies &amp; tracking</h2>
      <p>None. No analytics, no ads, no third-party scripts.</p>

      <h2>Third-party services</h2>
      <ul>
        <li><strong>Cloudflare</strong> — hosting (Pages, Workers, D1). Standard HTTP metadata may be processed. See <a href="https://www.cloudflare.com/privacypolicy/" target="_blank" rel="noopener">Cloudflare's privacy policy</a>.</li>
      </ul>

      <h2>Deletion</h2>
      <p>You can delete your page at any time from the view screen. Deletion is immediate and permanent.</p>

      <h2>Verify it yourself</h2>
      <p>The source code is at <a href="https://github.com/jkk1/callhome" target="_blank" rel="noopener">github.com/jkk1/callhome</a>. Every claim on this page can be verified by reading the code.</p>
    </div>
  `;
}

function renderTermsPage() {
  el('app').innerHTML = `
    <div class="static-page">
      <div class="page-hero">
        <h1>Terms of Service</h1>
        <p class="lead">Simple terms for a simple service.</p>
      </div>

      <h2>The service</h2>
      <p>Calling Home lets you create password-protected, end-to-end encrypted contact pages. It is provided free, as-is, with no warranty.</p>

      <h2>Your responsibilities</h2>
      <ul>
        <li>Keep your password safe. There is no password reset.</li>
        <li>Do not use the service to store illegal content or contact details of people without their consent.</li>
        <li>Do not abuse rate limits or attempt automated bulk creation.</li>
      </ul>

      <h2>Our responsibilities</h2>
      <ul>
        <li>We will not attempt to decrypt your data.</li>
        <li>We will not sell or share any stored data.</li>
        <li>We make reasonable efforts to maintain availability but do not guarantee uptime.</li>
      </ul>

      <h2>Limitation of liability</h2>
      <p>The service is provided "as is". We are not liable for data loss or inability to access your page. Keep your own backup of important contact information.</p>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOOTSTRAP
// ═══════════════════════════════════════════════════════════════════════════════

(function init() {
  document.addEventListener('click', e => {
    const link = e.target.closest('[data-route]');
    if (!link) return;
    e.preventDefault();
    const path = link.getAttribute('data-route') || link.getAttribute('href');
    if (path) navigate(path);
    el('mobile-nav')?.classList.remove('open');
  });

  window.addEventListener('popstate', () => route());

  el('nav-toggle')?.addEventListener('click', () => {
    el('mobile-nav')?.classList.toggle('open');
  });

  route();
})();
