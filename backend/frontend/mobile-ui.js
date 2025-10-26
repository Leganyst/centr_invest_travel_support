;(() => {
  const MobileUI = {
    init(){
      // 1) Гарантируем meta viewport
      if(!document.querySelector('meta[name="viewport"]')){
        const m=document.createElement('meta');
        m.name='viewport'; m.content='width=device-width, initial-scale=1, viewport-fit=cover';
        document.head.appendChild(m);
      }

      // 2) Получаем элементы
      this.app = document.querySelector('[data-app]') || document.body;
      this.sheet = document.querySelector('[data-route-list]');
      this.controls = document.querySelector('[data-controls]');
      this.toastStack = document.querySelector('.toast-stack') || (() => {
        const d=document.createElement('div'); d.className='toast-stack'; document.body.appendChild(d); return d;
      })();

      // 3) Инициализация состояния шторки
      if(this.sheet && !this.sheet.hasAttribute('data-state')){
        this.sheet.setAttribute('data-state', 'peek');
      }

      // 4) Кнопка-ручка (если добавите в разметку)
      const toggleBtn = this.sheet?.querySelector('[data-sheet-toggle]');
      toggleBtn?.addEventListener('click', () => this.toggleSheet());

      // 5) Хуки от приложения
      document.addEventListener('app:route-ready', () => this.expandSheet());
      document.addEventListener('app:view-route', () => this.expandSheet());

      // 6) Убираем 300ms задержку на iOS
      document.querySelectorAll('button, [role="button"], .btn').forEach(el => {
        el.style.touchAction = 'manipulation';
      });
    },
    toggleSheet(){
      if(!this.sheet) return;
      const isExpanded = this.sheet.getAttribute('data-state') === 'expanded';
      this.sheet.setAttribute('data-state', isExpanded ? 'peek' : 'expanded');
    },
    expandSheet(){ if(this.sheet) this.sheet.setAttribute('data-state','expanded'); },
    peekSheet(){ if(this.sheet) this.sheet.setAttribute('data-state','peek'); },
    hideSheet(){ if(this.sheet) this.sheet.setAttribute('data-state','hidden'); },

    showToast(msg, ms=2200){
      const t=document.createElement('div'); t.className='toast'; t.textContent=msg;
      this.toastStack.appendChild(t);
      setTimeout(() => {
        t.style.opacity='0'; t.style.transition='opacity .2s';
        t.addEventListener('transitionend', () => t.remove(), {once:true});
      }, ms);
    }
  };

  // Экспорт
  window.MobileUI = MobileUI;
})();