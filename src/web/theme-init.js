(function () {
  var root = document.documentElement;
  function read(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  var lang = read('guardian.lang');
  if (lang !== 'ar' && lang !== 'en') lang = (navigator.language || 'en').toLowerCase().indexOf('ar') === 0 ? 'ar' : 'en';
  root.lang = lang;
  root.dir = lang === 'ar' ? 'rtl' : 'ltr';
  var pref = read('guardian.theme');
  var dark = pref === 'dark' || ((pref !== 'light') && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) root.classList.add('dark');
})();
