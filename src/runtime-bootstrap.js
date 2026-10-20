(function setupLegacyDomInsertCompatibility() {
  'use strict';

  const originalAddEventListener = EventTarget.prototype.addEventListener;
  const observers = new WeakMap();

  EventTarget.prototype.addEventListener = function addEventListener(type, listener, options) {
    if (type !== 'DOMNodeInserted') {
      return originalAddEventListener.call(this, type, listener, options);
    }

    if (!observers.has(this)) {
      const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType !== Node.ELEMENT_NODE) return;

            const event = { target: node, type: 'DOMNodeInserted' };
            try {
              if (typeof listener === 'function') {
                listener.call(this, event);
              } else if (listener && typeof listener.handleEvent === 'function') {
                listener.handleEvent(event);
              }
            } catch (error) {
              console.error('[DOMNodeInserted compatibility]', error);
            }
          });
        });
      });
      observer.observe(this, { childList: true, subtree: true });
      observers.set(this, observer);
    }

    return undefined;
  };
})();
