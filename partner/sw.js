/* Helper для бизнеса — service worker кабинета (scope: /partner/).
   Ничего не кэширует и не перехватывает запросы: кабинет всегда загружается из сети.
   Нужен только для того, чтобы страницы кабинета не обрабатывал корневой service worker приложения водителя
   (scope /helper-app/), который кэширует навигацию как ./index.html. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
