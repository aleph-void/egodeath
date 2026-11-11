(function () {
  // Mobile menu
  var menuBtn = document.getElementById('mobile-menu-btn');
  var menu = document.getElementById('mobile-menu');
  if (menuBtn && menu) {
    menuBtn.addEventListener('click', function () {
      var open = menu.classList.toggle('open');
      menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    menu.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () {
        menu.classList.remove('open');
        menuBtn.setAttribute('aria-expanded', 'false');
      });
    });
  }

  // Nav shadow on scroll
  var nav = document.getElementById('nav');
  if (nav) {
    window.addEventListener('scroll', function () {
      nav.style.boxShadow = window.scrollY > 10 ? 'var(--shadow-sm)' : 'none';
    }, { passive: true });
  }

  // Copy buttons
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var src = document.getElementById(btn.getAttribute('data-copy'));
      if (!src || !navigator.clipboard) return;
      navigator.clipboard.writeText(src.textContent.trim()).then(function () {
        var label = btn.querySelector('span');
        btn.classList.add('copied');
        if (label) label.textContent = 'Copied';
        setTimeout(function () {
          btn.classList.remove('copied');
          if (label) label.textContent = 'Copy';
        }, 1600);
      }).catch(function () {});
    });
  });

  // Before / after tabs
  var tabs = document.querySelectorAll('.editor-tab');
  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      tabs.forEach(function (t) {
        var selected = t === tab;
        t.setAttribute('aria-selected', selected ? 'true' : 'false');
        document.getElementById(t.getAttribute('aria-controls')).hidden = !selected;
      });
    });
  });

  // Swap the static excerpt for the full sample output, which the deploy
  // workflow regenerates with the current egodeath build. The excerpt stays
  // if the fetch fails (or the page is opened from disk).
  var out = document.getElementById('sample-out');
  var meta = document.getElementById('editor-meta');
  if (out && window.fetch) {
    fetch('assets/sample/output.js')
      .then(function (r) { return r.ok ? r.text() : Promise.reject(r.status); })
      .then(function (text) {
        // Open on the first flattened function rather than the console stubs
        // at the top of the file; "Full output" links to the whole thing.
        var start = text.indexOf('while(true){switch(');
        out.textContent = start > 0 ? '…' + text.slice(start) : text;
        if (meta) {
          var kb = Math.round(new Blob([text]).size / 1024);
          meta.textContent = '8 lines → ' + kb + ' KB';
        }
      })
      .catch(function () { /* keep the excerpt */ });
  }
})();
