document.addEventListener('DOMContentLoaded', function () {
  /* ---------- mobile nav ---------- */
  var toggle = document.getElementById('navToggle');
  var nav = document.getElementById('siteNav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  /* ---------- flash auto-dismiss ---------- */
  document.querySelectorAll('.flash').forEach(function (el) {
    setTimeout(function () {
      el.style.transition = 'opacity .4s ease';
      el.style.opacity = '0';
      setTimeout(function () { el.remove(); }, 400);
    }, 5500);
  });

  /* ---------- scroll reveal ---------- */
  var revealEls = document.querySelectorAll(
    '.section, .featured, .row-item, .game-card, .team-card, .wl-item, .feature-cell, .stage-grid > *, .game-body-grid > *'
  );
  if ('IntersectionObserver' in window && revealEls.length) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -50px 0px' });

    revealEls.forEach(function (el, i) {
      el.classList.add('reveal-pending');
      el.style.transitionDelay = (i % 3) * 70 + 'ms';
      io.observe(el);
    });
  }

  /* ---------- game media gallery ---------- */
  var stage = document.getElementById('mediaStage');
  var thumbs = document.getElementById('mediaThumbs');
  if (stage && thumbs) {
    thumbs.addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;

      var type = btn.getAttribute('data-type');
      var mode = btn.getAttribute('data-mode');
      var src = btn.getAttribute('data-src');
      var poster = btn.getAttribute('data-poster');

      thumbs.querySelectorAll('button').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');

      if (type === 'video' && mode === 'video') {
        stage.innerHTML =
          '<video src="' + src + '" controls autoplay preload="metadata"' +
          (poster ? ' poster="' + poster + '"' : '') + '></video>';
      } else if (type === 'video') {
        stage.innerHTML =
          '<iframe src="' + src + '" title="Video" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>';
      } else {
        stage.innerHTML = '<img src="' + src + '" alt="Game artwork" referrerpolicy="no-referrer" />';
      }
    });
  }
});

/* ---------------------------------------------------------------
   Interactive hero — a light constellation field that leans toward
   the pointer. Deliberately cheap: capped particle count, paused
   when off-screen, and skipped entirely for reduced-motion users.
   --------------------------------------------------------------- */
(function () {
  var canvas = document.getElementById('heroCanvas');
  if (!canvas) return;

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) return;

  var ctx = canvas.getContext('2d');
  var dots = [];
  var w = 0, h = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
  var pointer = { x: -9999, y: -9999 };
  var running = true;
  var raf = null;

  function resize() {
    var rect = canvas.getBoundingClientRect();
    w = rect.width; h = rect.height;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Scale the count to the area, but never enough to cost real frames.
    var target = Math.min(90, Math.max(28, Math.round((w * h) / 16000)));
    dots = [];
    for (var i = 0; i < target; i++) {
      dots.push({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.22,
        vy: (Math.random() - 0.5) * 0.22,
        r: Math.random() * 1.6 + 0.7,
      });
    }
  }

  function step() {
    if (!running) { raf = null; return; }
    ctx.clearRect(0, 0, w, h);

    for (var i = 0; i < dots.length; i++) {
      var d = dots[i];
      d.x += d.vx; d.y += d.vy;

      if (d.x < -20) d.x = w + 20; else if (d.x > w + 20) d.x = -20;
      if (d.y < -20) d.y = h + 20; else if (d.y > h + 20) d.y = -20;

      // gentle pull toward the pointer
      var pdx = pointer.x - d.x, pdy = pointer.y - d.y;
      var pd2 = pdx * pdx + pdy * pdy;
      if (pd2 < 26000 && pd2 > 1) {
        var pull = 0.00016 * (26000 - pd2) / 26000;
        d.vx += pdx * pull; d.vy += pdy * pull;
      }
      // keep speeds sane
      d.vx = Math.max(-0.7, Math.min(0.7, d.vx * 0.995));
      d.vy = Math.max(-0.7, Math.min(0.7, d.vy * 0.995));

      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(180,242,48,0.5)';
      ctx.fill();
    }

    // link nearby dots
    for (var a = 0; a < dots.length; a++) {
      for (var b = a + 1; b < dots.length; b++) {
        var dx = dots[a].x - dots[b].x, dy = dots[a].y - dots[b].y;
        var dist2 = dx * dx + dy * dy;
        if (dist2 < 12000) {
          ctx.beginPath();
          ctx.moveTo(dots[a].x, dots[a].y);
          ctx.lineTo(dots[b].x, dots[b].y);
          ctx.strokeStyle = 'rgba(180,242,48,' + (0.16 * (1 - dist2 / 12000)).toFixed(3) + ')';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
    }

    raf = requestAnimationFrame(step);
  }

  function start() { if (!raf) { running = true; raf = requestAnimationFrame(step); } }
  function stop() { running = false; }

  canvas.addEventListener('pointermove', function (e) {
    var rect = canvas.getBoundingClientRect();
    pointer.x = e.clientX - rect.left;
    pointer.y = e.clientY - rect.top;
  });
  canvas.addEventListener('pointerleave', function () { pointer.x = pointer.y = -9999; });

  window.addEventListener('resize', resize);

  // Don't burn cycles animating a hero nobody is looking at.
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { en.isIntersecting ? start() : stop(); });
    }, { threshold: 0.02 }).observe(canvas);
  } else {
    start();
  }
  document.addEventListener('visibilitychange', function () {
    document.hidden ? stop() : start();
  });

  resize();
  start();
})();

/* Hero title: split into characters once so CSS can stagger them in. */
(function () {
  var title = document.getElementById('heroTitle');
  if (!title) return;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) { title.classList.add('is-in'); return; }

  var lines = title.querySelectorAll('.hv-line');
  var index = 0;
  lines.forEach(function (line) {
    var text = line.textContent;
    line.textContent = '';
    for (var i = 0; i < text.length; i++) {
      var span = document.createElement('span');
      span.className = 'hv-ch';
      span.textContent = text[i] === ' ' ? ' ' : text[i];
      span.style.animationDelay = (index * 32) + 'ms';
      line.appendChild(span);
      index++;
    }
  });
  requestAnimationFrame(function () { title.classList.add('is-in'); });
})();

/* ---------------------------------------------------------------
   Like / dislike without a page reload. The forms work fine on
   their own if JS is off — this just makes them feel instant.
   --------------------------------------------------------------- */
(function () {
  var groups = document.querySelectorAll('.reactions');
  if (!groups.length) return;

  groups.forEach(function (group) {
    var forms = group.querySelectorAll('form');

    forms.forEach(function (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();

        var btn = form.querySelector('button');
        if (btn.disabled) return;
        btn.disabled = true;

        fetch(form.action, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: new URLSearchParams(new FormData(form)).toString(),
          credentials: 'same-origin',
        })
          .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
          .then(function (data) {
            var all = group.querySelectorAll('.react-btn');
            var up = all[0], down = all[1];
            if (up) {
              up.querySelector('span').textContent = data.likes;
              up.classList.toggle('is-on', data.myVote === 1);
            }
            if (down) {
              down.querySelector('span').textContent = data.dislikes;
              down.classList.toggle('is-on', data.myVote === -1);
            }
          })
          .catch(function () {
            // Something went wrong — fall back to a normal submit so the click
            // still counts rather than silently doing nothing.
            form.submit();
          })
          .then(function () { btn.disabled = false; });
      });
    });
  });
})();


/* ==========================================================================
   CYBERPUNK WEB ARCADE EMULATOR & IN-GAME RUNNER
   ========================================================================== */
(function () {
  document.addEventListener('DOMContentLoaded', function () {
    var emuContainer = document.getElementById('cyberEmulator');
    var mediaStage = document.getElementById('mediaStage');
    var btnShowEmulator = document.getElementById('btnShowEmulator');
    var btnShowGallery = document.getElementById('btnShowGallery');
    var mediaThumbs = document.getElementById('mediaThumbs');

    // Stage Mode Switcher (Web Arcade vs Media Gallery)
    if (btnShowEmulator && btnShowGallery && emuContainer && mediaStage) {
      btnShowEmulator.addEventListener('click', function () {
        btnShowEmulator.classList.add('active');
        btnShowGallery.classList.remove('active');
        emuContainer.style.display = 'block';
        mediaStage.style.display = 'none';
        playCyberAudio('click');
      });

      btnShowGallery.addEventListener('click', function () {
        btnShowGallery.classList.add('active');
        btnShowEmulator.classList.remove('active');
        emuContainer.style.display = 'none';
        mediaStage.style.display = 'block';
        playCyberAudio('click');
      });

      // Clicking any gallery thumbnail automatically switches to the gallery
      if (mediaThumbs) {
        mediaThumbs.addEventListener('click', function () {
          if (btnShowGallery && !btnShowGallery.classList.contains('active')) {
            btnShowGallery.classList.add('active');
            btnShowEmulator.classList.remove('active');
            emuContainer.style.display = 'none';
            mediaStage.style.display = 'block';
          }
        });
      }
    }

    // Audio synthesizer (Zero external dependencies)
    function playCyberAudio(type) {
      try {
        var AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        var actx = new AudioCtx();
        var osc = actx.createOscillator();
        var gain = actx.createGain();
        osc.connect(gain);
        gain.connect(actx.destination);

        if (type === 'boot') {
          osc.type = 'sawtooth';
          osc.frequency.setValueAtTime(120, actx.currentTime);
          osc.frequency.exponentialRampToValueAtTime(880, actx.currentTime + 0.35);
          gain.gain.setValueAtTime(0.12, actx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.01, actx.currentTime + 0.35);
          osc.start();
          osc.stop(actx.currentTime + 0.35);
        } else if (type === 'poweroff') {
          osc.type = 'sine';
          osc.frequency.setValueAtTime(440, actx.currentTime);
          osc.frequency.exponentialRampToValueAtTime(50, actx.currentTime + 0.25);
          gain.gain.setValueAtTime(0.12, actx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.01, actx.currentTime + 0.25);
          osc.start();
          osc.stop(actx.currentTime + 0.25);
        } else {
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(540, actx.currentTime);
          gain.gain.setValueAtTime(0.08, actx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.01, actx.currentTime + 0.08);
          osc.start();
          osc.stop(actx.currentTime + 0.08);
        }
      } catch (e) {}
    }

    // Decryption Routine (in-memory RC4 streaming cipher)
    function decryptSessionPayload(base64Str, keyStr) {
      var binaryStr = atob(base64Str);
      var len = binaryStr.length;
      var bytes = new Uint8Array(len);
      for (var k = 0; k < len; k++) {
        bytes[k] = binaryStr.charCodeAt(k);
      }

      var s = [];
      for (var idx = 0; idx < 256; idx++) s[idx] = idx;
      var j = 0;
      for (var i = 0; i < 256; i++) {
        j = (j + s[i] + keyStr.charCodeAt(i % keyStr.length)) % 256;
        var tmp = s[i]; s[i] = s[j]; s[j] = tmp;
      }

      var ii = 0;
      var jj = 0;
      var out = new Uint8Array(len);
      for (var kk = 0; kk < len; kk++) {
        ii = (ii + 1) % 256;
        jj = (jj + s[ii]) % 256;
        var t1 = s[ii]; s[ii] = s[jj]; s[jj] = t1;
        var t2 = (s[ii] + s[jj]) % 256;
        out[kk] = bytes[kk] ^ s[t2];
      }

      var decoder = new TextDecoder('utf-8');
      return decoder.decode(out);
    }

    // Emulator Engine Controller
    if (emuContainer) {
      var emuSlug = emuContainer.getAttribute('data-slug');
      var emuRunBtn = document.getElementById('emuRunBtn');
      var emuStandby = document.getElementById('emuStandby');
      var emuBoot = document.getElementById('emuBoot');
      var emuBootProgress = document.getElementById('emuBootProgress');
      var emuGameContainer = document.getElementById('emuGameContainer');
      var emuIframe = document.getElementById('emuIframe');
      var emuHudControls = document.getElementById('emuHudControls');
      var emuStandbyHint = document.getElementById('emuStandbyHint');
      var emuFpsCounter = document.getElementById('emuFpsCounter');
      var emuScanlines = document.getElementById('emuScanlines');

      var btnRestart = document.getElementById('emuBtnRestart');
      var btnMute = document.getElementById('emuBtnMute');
      var btnScanlines = document.getElementById('emuBtnScanlines');
      var btnTheater = document.getElementById('emuBtnTheater');
      var btnFullscreen = document.getElementById('emuBtnFullscreen');
      var btnPowerOff = document.getElementById('emuBtnPowerOff');

      var cachedSessionData = null;

      // Prevent right-click inspect on the emulator bezel and screen
      emuContainer.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        return false;
      });

      // Launch game routine
      function launchGame() {
        playCyberAudio('boot');
        emuStandby.style.display = 'none';
        emuBoot.style.display = 'flex';
        emuBootProgress.style.width = '0%';

        setTimeout(function () { emuBootProgress.style.width = '65%'; }, 100);

        fetch('/api/games/' + encodeURIComponent(emuSlug) + '/emulator-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
          .then(function (res) {
            if (!res.ok) throw new Error('Failed to retrieve game session from vault.');
            return res.json();
          })
          .then(function (data) {
            cachedSessionData = data;
            emuBootProgress.style.width = '100%';

            setTimeout(function () {
              try {
                var decryptedHtml = decryptSessionPayload(data.payload, data.sessionKey);
                var blob = new Blob([decryptedHtml], { type: 'text/html' });
                var blobUrl = URL.createObjectURL(blob);

                emuIframe.src = blobUrl;
                // Instantly revoke Object URL so it cannot be copied or fetched outside RAM
                setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 200);

                emuBoot.style.display = 'none';
                emuGameContainer.style.display = 'block';
                emuHudControls.style.display = 'flex';
                emuStandbyHint.style.display = 'none';
                if (emuFpsCounter) emuFpsCounter.style.display = 'inline-block';
              } catch (decErr) {
                console.error('Decryption failed:', decErr);
                alert('Could not initialize in-memory game: ' + decErr.message);
                powerOffGame();
              }
            }, 350);
          })
          .catch(function (err) {
            console.error(err);
            alert('Could not start emulator: ' + err.message);
            powerOffGame();
          });
      }

      function powerOffGame() {
        playCyberAudio('poweroff');
        if (emuIframe) emuIframe.src = 'about:blank';
        emuGameContainer.style.display = 'none';
        emuBoot.style.display = 'none';
        emuHudControls.style.display = 'none';
        emuStandby.style.display = 'flex';
        emuStandbyHint.style.display = 'flex';
        if (emuFpsCounter) emuFpsCounter.style.display = 'none';
        emuContainer.classList.remove('is-theater');
        if (btnTheater) {
          btnTheater.classList.remove('active');
          btnTheater.innerText = '⛶ Theater';
        }
      }

      if (emuRunBtn) {
        emuRunBtn.addEventListener('click', launchGame);
      }

      if (btnRestart) {
        btnRestart.addEventListener('click', function () {
          playCyberAudio('click');
          if (cachedSessionData) {
            var decryptedHtml = decryptSessionPayload(cachedSessionData.payload, cachedSessionData.sessionKey);
            var blob = new Blob([decryptedHtml], { type: 'text/html' });
            var blobUrl = URL.createObjectURL(blob);
            emuIframe.src = blobUrl;
            setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 200);
          } else {
            launchGame();
          }
        });
      }

      if (btnMute) {
        var isMuted = false;
        btnMute.addEventListener('click', function () {
          playCyberAudio('click');
          isMuted = !isMuted;
          btnMute.innerText = isMuted ? '🔇 Muted' : '🔊 Sound';
          btnMute.classList.toggle('active', isMuted);
          try {
            if (emuIframe.contentWindow) {
              emuIframe.contentWindow.postMessage({ type: 'HOWL_EMU_SET_MUTED', muted: isMuted }, '*');
            }
          } catch (e) {}
        });
      }

      if (btnScanlines) {
        btnScanlines.addEventListener('click', function () {
          playCyberAudio('click');
          var off = emuScanlines.classList.toggle('scanlines-off');
          btnScanlines.classList.toggle('active', !off);
        });
      }

      if (btnTheater) {
        btnTheater.addEventListener('click', function () {
          playCyberAudio('click');
          var isTheater = emuContainer.classList.toggle('is-theater');
          btnTheater.classList.toggle('active', isTheater);
          btnTheater.innerText = isTheater ? '⛶ Exit Theater' : '⛶ Theater';
          if (isTheater) {
            emuContainer.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        });
      }

      if (btnFullscreen) {
        btnFullscreen.addEventListener('click', function () {
          playCyberAudio('click');
          if (!document.fullscreenElement) {
            if (emuContainer.requestFullscreen) {
              emuContainer.requestFullscreen();
            } else if (emuContainer.webkitRequestFullscreen) {
              emuContainer.webkitRequestFullscreen();
            }
          } else {
            if (document.exitFullscreen) {
              document.exitFullscreen();
            }
          }
        });
      }

      if (btnPowerOff) {
        btnPowerOff.addEventListener('click', powerOffGame);
      }
    }
  });
})();
