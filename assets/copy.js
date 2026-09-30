// Copy buttons on the example prompts.
document.querySelectorAll('.copy').forEach(function (btn) {
  btn.addEventListener('click', function () {
    var pre = btn.parentElement;
    var text = pre.firstChild.textContent.trim();
    var done = function () {
      btn.setAttribute('aria-label', 'Copied');
      btn.innerHTML = '<svg class="i"><use href="#i-check"/></svg>';
      setTimeout(function () {
        btn.setAttribute('aria-label', 'Copy prompt');
        btn.innerHTML = '<svg class="i"><use href="#i-copy"/></svg>';
      }, 1400);
    };
    var fallback = function () {
      var range = document.createRange();
      range.selectNodeContents(pre.firstChild);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    };
    try {
      navigator.clipboard.writeText(text).then(done, fallback);
    } catch (e) { fallback(); }
  });
});
