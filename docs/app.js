document.querySelectorAll('[data-switch]').forEach((sw) => {
  const tabs = [...sw.querySelectorAll('[role="tab"]')];
  const panels = [...sw.querySelectorAll('[role="tabpanel"]')];

  const activate = (tab, moveFocus = false) => {
    const targetId = tab.getAttribute('aria-controls');
    tabs.forEach((t) => {
      const active = t === tab;
      t.setAttribute('aria-selected', String(active));
      t.tabIndex = active ? 0 : -1;
    });
    panels.forEach((p) => {
      p.hidden = p.id !== targetId;
    });
    if (moveFocus) tab.focus();
  };

  tabs.forEach((tab, idx) => {
    tab.addEventListener('click', () => activate(tab, false));
    tab.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        activate(tabs[(idx + 1) % tabs.length], true);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        activate(tabs[(idx - 1 + tabs.length) % tabs.length], true);
      }
    });
  });
});

const copyNote = document.getElementById('copyStatus');
document.querySelectorAll('[data-copy]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const cmd = btn.getAttribute('data-copy') || '';
    try {
      await navigator.clipboard.writeText(cmd);
      btn.textContent = 'Copied';
      if (copyNote) copyNote.textContent = `Copied: ${cmd}`;
      setTimeout(() => { btn.textContent = 'Copy command'; }, 1800);
    } catch (_) {
      if (copyNote) copyNote.textContent = `Run in terminal: ${cmd}`;
    }
  });
});

const io = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add('is-in');
      io.unobserve(entry.target);
    }
  });
}, { rootMargin: '0px 0px -10% 0px' });

document.querySelectorAll('[data-reveal]').forEach((el) => io.observe(el));
