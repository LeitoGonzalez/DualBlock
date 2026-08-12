/**
 * DualBlock — Service Worker (background.js)
 *
 * Detecta pestañas duplicadas en sitios protegidos y las cierra
 * automáticamente, enfocando la pestaña original.
 *
 * Permisos utilizados:
 *   tabs          — leer URL de pestañas, cerrarlas, activarlas y consultar todas
 *   storage       — persistir configuración y estadísticas localmente
 *   notifications — mostrar aviso cuando se bloquea una pestaña duplicada
 *   windows       — enfocar la ventana que contiene la pestaña original
 */

'use strict';

// ─── Constantes ───────────────────────────────────────────────────────────────

const STORAGE_SETTINGS_KEY = 'settings';
const STORAGE_STATS_KEY    = 'stats';

/** Tiempo de espera en modo "advertencia" antes de cerrar automáticamente (ms). */
const WARN_TIMEOUT_MS = 8000;

/** Configuración por defecto. Se aplica cuando no hay nada guardado en storage. */
const DEFAULT_SETTINGS = {
  enabled: true,
  sites: [],
  comparisonMode: 'exact',      // 'exact' | 'ignore-params'
  behaviorOnDuplicate: 'close', // 'close' | 'warn'
  showNotifications: true,
};

// ─── Estado en memoria ────────────────────────────────────────────────────────

/**
 * Configuración activa (cargada desde storage al iniciar el SW).
 * Se actualiza automáticamente via chrome.storage.onChanged.
 */
let settings = { ...DEFAULT_SETTINGS };

/**
 * IDs de pestañas que están siendo procesadas en este momento.
 * Evita que el evento onUpdated / onCreated que dispara el propio cierre
 * de la pestaña vuelva a iniciar la lógica de detección (bucle infinito).
 */
const processingTabs = new Set();

/**
 * Timers pendientes del modo "advertencia".
 * Mapa: tabId → { timerId, notifId, originalTab, url }
 * Nota: los setTimeout no sobreviven a la terminación del service worker;
 * si el SW muere mientras el timer está activo, la pestaña simplemente
 * quedará abierta (comportamiento conservador / no destructivo).
 */
const warnTimers = new Map();

// ─── Utilidades de URL ────────────────────────────────────────────────────────

/**
 * Normaliza una URL para compararla con otras según el modo configurado.
 *
 * Modo 'exact' (predeterminado):
 *   Compara: protocolo + dominio + ruta + query string + hash
 *   Ejemplo: "…/factura.faces?id=1#top" ≠ "…/factura.faces?id=2"
 *
 * Modo 'ignore-params':
 *   Compara: protocolo + dominio + ruta (ignora query string y hash)
 *   Ejemplo: "…/factura.faces?id=1" == "…/factura.faces?id=2"
 *
 * En ambos modos se elimina el trailing slash de la ruta (salvo la raíz "/")
 * para evitar falsos negativos por ese motivo.
 *
 * @param {string} rawUrl - URL a normalizar
 * @param {'exact'|'ignore-params'} mode - Modo de comparación
 * @returns {string} Clave de comparación
 */
function normalizeUrl(rawUrl, mode) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl; // URL inválida: usar cadena cruda como clave
  }

  // Eliminar trailing slash de la ruta (excepto si la ruta es solo "/")
  let pathname = url.pathname;
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }

  if (mode === 'ignore-params') {
    return `${url.protocol}//${url.host}${pathname}`;
  }

  // Modo 'exact': incluir query string y hash
  return `${url.protocol}//${url.host}${pathname}${url.search}${url.hash}`;
}

/**
 * Determina si una URL pertenece a alguno de los sitios protegidos activos.
 *
 * @param {string} rawUrl
 * @returns {boolean}
 */
function isProtectedUrl(rawUrl) {
  if (!rawUrl) return false;

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  // Solo HTTP y HTTPS; ignorar chrome://, file://, etc.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  const host = url.hostname.toLowerCase();

  return settings.sites.some((site) => {
    if (!site.enabled) return false;
    const domain = site.domain.toLowerCase().trim();
    // Coincidencia exacta o subdominio del dominio configurado
    return host === domain || host.endsWith('.' + domain);
  });
}

/**
 * Devuelve true si la URL es una URL de sistema que debemos ignorar.
 *
 * @param {string} url
 * @returns {boolean}
 */
function isSystemUrl(url) {
  if (!url) return true;
  return (
    url === 'about:blank'      ||
    url === 'about:newtab'     ||
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('edge://')
  );
}

// ─── Lógica de detección ──────────────────────────────────────────────────────

/**
 * Busca en todas las pestañas abiertas si alguna (distinta a `newTabId`)
 * tiene la misma URL normalizada y pertenece a un sitio protegido.
 *
 * Para garantizar determinismo cuando hay múltiples candidatas, devuelve
 * la pestaña con menor ID (la más antigua).
 *
 * @param {number} newTabId - ID de la pestaña que se acaba de crear/cambiar
 * @param {string} newUrl   - URL a comparar
 * @returns {Promise<chrome.tabs.Tab|null>}
 */
async function findOriginalTab(newTabId, newUrl) {
  const newKey = normalizeUrl(newUrl, settings.comparisonMode);

  let allTabs;
  try {
    allTabs = await chrome.tabs.query({});
  } catch {
    return null;
  }

  let originalTab = null;

  for (const tab of allTabs) {
    if (tab.id === newTabId) continue;
    if (!tab.url || isSystemUrl(tab.url)) continue;
    if (!isProtectedUrl(tab.url)) continue;

    const existingKey = normalizeUrl(tab.url, settings.comparisonMode);
    if (existingKey !== newKey) continue;

    // Candidata encontrada; quedarse con la de menor ID (más antigua)
    if (originalTab === null || tab.id < originalTab.id) {
      originalTab = tab;
    }
  }

  return originalTab;
}

// ─── Estadísticas ─────────────────────────────────────────────────────────────

/**
 * Incrementa el contador de duplicados bloqueados en chrome.storage.local.
 * Usa storage.local (no sync) para no sincronizar el contador entre dispositivos.
 */
async function incrementBlockedCount() {
  try {
    const data  = await chrome.storage.local.get(STORAGE_STATS_KEY);
    const stats = data[STORAGE_STATS_KEY] || { blockedCount: 0 };
    stats.blockedCount = (stats.blockedCount ?? 0) + 1;
    await chrome.storage.local.set({ [STORAGE_STATS_KEY]: stats });
  } catch {
    // No crítico; el contador puede quedar desfasado
  }
}

// ─── Notificaciones ───────────────────────────────────────────────────────────

/**
 * Muestra una notificación informando que se bloqueó una pestaña duplicada.
 * El botón "Ir a la pestaña existente" activa la pestaña original.
 *
 * @param {number} originalTabId - ID de la pestaña que se conservó
 * @param {number} originalWindowId - ID de la ventana de la pestaña original
 * @param {string} url           - URL que se consideró duplicada
 */
function showBlockedNotification(originalTabId, originalWindowId, url) {
  if (!settings.showNotifications) return;

  let path = url;
  try {
    path = new URL(url).pathname;
  } catch { /* usar url cruda */ }

  const notifId = `blocked-${Date.now()}`;

  chrome.notifications.create(notifId, {
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: 'DualBlock',
    message: `Esta página ya está abierta en otra pestaña.\n${path}`,
    buttons: [{ title: 'Ir a la pestaña existente' }],
    priority: 1,
  }, () => {
    if (chrome.runtime.lastError) return;

    const onButton = (id, btnIndex) => {
      if (id !== notifId || btnIndex !== 0) return;
      chrome.notifications.onButtonClicked.removeListener(onButton);
      chrome.notifications.clear(notifId).catch(() => {});
      chrome.tabs.update(originalTabId, { active: true }).catch(() => {});
      chrome.windows.update(originalWindowId, { focused: true }).catch(() => {});
    };

    chrome.notifications.onButtonClicked.addListener(onButton);

    // Limpiar listener tras 60 s para no acumular listeners huérfanos
    setTimeout(() => {
      chrome.notifications.onButtonClicked.removeListener(onButton);
    }, 60_000);
  });
}

// ─── Acciones sobre pestañas ──────────────────────────────────────────────────

/**
 * Cierra la pestaña duplicada y activa la pestaña original.
 *
 * @param {number} duplicateTabId
 * @param {chrome.tabs.Tab} originalTab
 * @param {string} url
 */
async function closeDuplicateAndFocus(duplicateTabId, originalTab, url) {
  try {
    await chrome.tabs.remove(duplicateTabId);
  } catch {
    // La pestaña puede haberse cerrado ya; continuar de todos modos
  }

  try {
    await chrome.tabs.update(originalTab.id, { active: true });
    await chrome.windows.update(originalTab.windowId, { focused: true });
  } catch {
    // Si la pestaña original ya no existe, no hacer nada
  }

  showBlockedNotification(originalTab.id, originalTab.windowId, url);
}

/**
 * Modo "advertencia": muestra una notificación con botones y cierra
 * automáticamente tras WARN_TIMEOUT_MS si el usuario no interviene.
 *
 * @param {number} duplicateTabId
 * @param {chrome.tabs.Tab} originalTab
 * @param {string} url
 */
async function handleWarnMode(duplicateTabId, originalTab, url) {
  // Sin notificaciones habilitadas, cerrar directamente
  if (!settings.showNotifications) {
    await closeDuplicateAndFocus(duplicateTabId, originalTab, url);
    return;
  }

  let path = url;
  try {
    path = new URL(url).pathname;
  } catch { /* usar url cruda */ }

  const notifId = `warn-${duplicateTabId}-${Date.now()}`;
  const seconds = Math.round(WARN_TIMEOUT_MS / 1000);

  chrome.notifications.create(notifId, {
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: 'DualBlock — Duplicado detectado',
    message: `Esta pantalla ya está abierta en otra pestaña:\n${path}\n\nSe cerrará en ${seconds} segundos.`,
    buttons: [
      { title: 'Cerrar ahora y volver a la original' },
      { title: 'Mantener ambas pestañas' },
    ],
    requireInteraction: false,
    priority: 2,
  }, () => {
    if (chrome.runtime.lastError) {
      // Si no se pudo crear la notificación, cerrar directamente
      closeDuplicateAndFocus(duplicateTabId, originalTab, url);
      return;
    }
  });

  // Timer de auto-cierre
  const timerId = setTimeout(async () => {
    warnTimers.delete(duplicateTabId);
    chrome.notifications.clear(notifId).catch(() => {});
    await closeDuplicateAndFocus(duplicateTabId, originalTab, url);
  }, WARN_TIMEOUT_MS);

  warnTimers.set(duplicateTabId, { timerId, notifId, originalTab, url });

  // Handler de botones de la notificación
  const onButton = async (id, btnIndex) => {
    if (id !== notifId) return;

    chrome.notifications.onButtonClicked.removeListener(onButton);
    chrome.notifications.onClosed.removeListener(onClosed);

    const entry = warnTimers.get(duplicateTabId);
    if (entry) {
      clearTimeout(entry.timerId);
      warnTimers.delete(duplicateTabId);
    }
    chrome.notifications.clear(notifId).catch(() => {});

    if (btnIndex === 0) {
      // Cerrar y enfocar original
      await closeDuplicateAndFocus(duplicateTabId, originalTab, url);
    } else {
      // Mantener ambas; liberar el bloqueo de procesamiento
      processingTabs.delete(duplicateTabId);
    }
  };

  // Si la notificación se cierra sin clic (se descarta o expira en el centro),
  // el timer sigue corriendo y cerrará la pestaña al vencer.
  const onClosed = (id) => {
    if (id !== notifId) return;
    chrome.notifications.onClosed.removeListener(onClosed);
    chrome.notifications.onButtonClicked.removeListener(onButton);
  };

  chrome.notifications.onButtonClicked.addListener(onButton);
  chrome.notifications.onClosed.addListener(onClosed);
}

/**
 * Punto de entrada para manejar una pestaña detectada como duplicada.
 *
 * @param {number} duplicateTabId
 * @param {chrome.tabs.Tab} originalTab
 * @param {string} url
 */
async function handleDuplicate(duplicateTabId, originalTab, url) {
  processingTabs.add(duplicateTabId);

  try {
    await incrementBlockedCount();

    if (settings.behaviorOnDuplicate === 'warn') {
      await handleWarnMode(duplicateTabId, originalTab, url);
    } else {
      await closeDuplicateAndFocus(duplicateTabId, originalTab, url);
    }
  } finally {
    // Liberar el bloqueo con un pequeño retraso para absorber los eventos
    // que Chrome dispara al cerrar la propia pestaña.
    if (settings.behaviorOnDuplicate !== 'warn') {
      setTimeout(() => processingTabs.delete(duplicateTabId), 1500);
    }
  }
}

// ─── Punto de entrada: verificar una pestaña ──────────────────────────────────

/**
 * Verifica si una pestaña con una URL determinada es duplicada de otra ya abierta.
 * Llama a handleDuplicate si se confirma la duplicación.
 *
 * @param {number} tabId
 * @param {string} url
 */
async function checkTab(tabId, url) {
  if (!settings.enabled)    return;
  if (isSystemUrl(url))     return;
  if (!isProtectedUrl(url)) return;
  if (processingTabs.has(tabId)) return;

  const originalTab = await findOriginalTab(tabId, url);
  if (!originalTab) return;

  await handleDuplicate(tabId, originalTab, url);
}

// ─── Verificación inicial de pestañas existentes ──────────────────────────────

/**
 * Al instalar o arrancar Chrome, revisa las pestañas ya abiertas y cierra
 * las duplicadas de forma determinista:
 *   - Ordena por ID ascendente → el de menor ID es el más "antiguo".
 *   - Conserva el primero (menor ID) y cierra los demás duplicados.
 *
 * Si dos pestañas tienen la misma URL exacta al arrancar Chrome, se cierra
 * la de mayor ID y se conserva la de menor ID.
 */
async function checkExistingTabs() {
  if (!settings.enabled) return;

  let allTabs;
  try {
    allTabs = await chrome.tabs.query({});
  } catch {
    return;
  }

  // Filtrar solo pestañas de sitios protegidos con URL válida
  const protectedTabs = allTabs
    .filter((t) => t.url && !isSystemUrl(t.url) && isProtectedUrl(t.url))
    .sort((a, b) => a.id - b.id); // menor ID primero = más antiguo

  // urlMap: clave normalizada → primera pestaña encontrada (la más antigua)
  const urlMap = new Map();

  for (const tab of protectedTabs) {
    const key = normalizeUrl(tab.url, settings.comparisonMode);

    if (!urlMap.has(key)) {
      urlMap.set(key, tab);
    } else {
      // Duplicada: cerrar esta (tiene ID mayor)
      processingTabs.add(tab.id);
      try {
        await chrome.tabs.remove(tab.id);
        await incrementBlockedCount();
        const original = urlMap.get(key);
        showBlockedNotification(original.id, original.windowId, tab.url);
      } catch { /* ignorar si ya estaba cerrada */ }
      setTimeout(() => processingTabs.delete(tab.id), 1500);
    }
  }
}

// ─── Carga de configuración ───────────────────────────────────────────────────

/**
 * Carga la configuración guardada desde chrome.storage.sync.
 * Combina con DEFAULT_SETTINGS para asegurar que todos los campos existen.
 */
async function loadSettings() {
  try {
    const data = await chrome.storage.sync.get(STORAGE_SETTINGS_KEY);
    if (data[STORAGE_SETTINGS_KEY]) {
      settings = { ...DEFAULT_SETTINGS, ...data[STORAGE_SETTINGS_KEY] };
      if (!Array.isArray(settings.sites)) {
        settings.sites = DEFAULT_SETTINGS.sites;
      }
    }
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
}

// ─── Listeners de Chrome ──────────────────────────────────────────────────────

/**
 * Nueva pestaña creada.
 * A veces Chrome asigna la URL en el momento de creación (e.g. abrir enlace
 * en nueva pestaña en segundo plano). Se verifica si la URL ya está asignada.
 */
chrome.tabs.onCreated.addListener((tab) => {
  const url = tab.url || tab.pendingUrl;
  if (url && !isSystemUrl(url)) {
    checkTab(tab.id, url);
  }
});

/**
 * Una pestaña cambió su URL o estado.
 * changeInfo.url solo está presente cuando la URL efectivamente cambia.
 * Esto captura:
 *   - Navegación normal (incluyendo F5 / actualización)
 *   - Pegar URL en la barra de direcciones
 *   - Abrir desde favoritos / historial
 *   - Abrir desde un enlace (en la misma pestaña)
 *   - Cambios de URL SPA si el navegador los propaga a tabs.onUpdated
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  checkTab(tabId, changeInfo.url);
});

/**
 * Una pestaña fue cerrada.
 * Limpiar su estado de procesamiento y cancelar cualquier timer de advertencia.
 */
chrome.tabs.onRemoved.addListener((tabId) => {
  processingTabs.delete(tabId);

  const entry = warnTimers.get(tabId);
  if (entry) {
    clearTimeout(entry.timerId);
    chrome.notifications.clear(entry.notifId).catch(() => {});
    warnTimers.delete(tabId);
  }
});

/**
 * El usuario guardó nueva configuración desde la página de opciones.
 * Actualizar la configuración en memoria sin recargar el service worker.
 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes[STORAGE_SETTINGS_KEY]) {
    const newValue = changes[STORAGE_SETTINGS_KEY].newValue;
    if (newValue) {
      settings = { ...DEFAULT_SETTINGS, ...newValue };
      if (!Array.isArray(settings.sites)) {
        settings.sites = DEFAULT_SETTINGS.sites;
      }
    }
  }
});

/**
 * Clic en el ícono de la extensión en la barra de herramientas.
 * Abre la página de opciones.
 */
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

/**
 * Instalación o actualización de la extensión.
 * En instalación: guardar configuración por defecto.
 * En cualquier caso: verificar pestañas existentes.
 */
chrome.runtime.onInstalled.addListener(async (details) => {
  await loadSettings();

  if (details.reason === 'install') {
    await chrome.storage.sync.set({ [STORAGE_SETTINGS_KEY]: settings });
  }

  // Pequeño delay para que Chrome termine de inicializar todas las pestañas
  setTimeout(checkExistingTabs, 600);
});

/**
 * Chrome arrancó (con la extensión ya instalada y pestañas restauradas).
 * Mayor delay para que el navegador restaure completamente las pestañas
 * de la sesión anterior antes de verificar duplicados.
 */
chrome.runtime.onStartup.addListener(async () => {
  await loadSettings();
  setTimeout(checkExistingTabs, 1800);
});

// Carga inicial de settings (por si el SW se reinicia entre eventos)
loadSettings();
