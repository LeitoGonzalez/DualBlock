# DualBlock

Extensión de Google Chrome que evita tener pestañas duplicadas en cualquier sitio web. Cuando detecta que una pestaña tiene la misma URL que otra ya abierta, cierra la duplicada automáticamente y enfoca la original.

Ideal para ERPs, CRMs, sistemas de facturación o cualquier aplicación web donde tener la misma pantalla abierta dos veces puede generar conflictos de sesión, datos o procesos.

---

## ¿Qué hace?

Cuando se abre una pestaña con la misma URL que otra ya existente en un sitio protegido:

1. **Cierra la pestaña duplicada** (o muestra una advertencia, según configuración).
2. **Activa y enfoca** la pestaña original.
3. **Muestra una notificación breve** con la opción "Ir a la pestaña existente".

Las pestañas con **URLs diferentes** nunca se ven afectadas.

**Ejemplo — pestañas que pueden coexistir:**
```
https://app.empresa.com/facturas
https://app.empresa.com/clientes
https://app.empresa.com/configuracion
```

**Ejemplo — duplicado bloqueado:**
```
https://app.empresa.com/facturas  ← pestaña original (se mantiene)
https://app.empresa.com/facturas  ← DUPLICADA → se cierra automáticamente
```

---

## Instalación (modo desarrollador)

1. Descargá o cloná este repositorio en tu equipo.
2. Abrí Chrome y navegá a `chrome://extensions`.
3. Activá el **Modo desarrollador** (switch en la esquina superior derecha).
4. Hacé clic en **"Cargar descomprimida"**.
5. Seleccioná la carpeta del proyecto.
6. El ícono de DualBlock aparece en la barra de herramientas de Chrome.

---

## Abrir la configuración

- **Clic** en el ícono de DualBlock en la barra de herramientas.
- O desde `chrome://extensions` → DualBlock → **"Detalles"** → **"Opciones de extensión"**.

---

## Configuración disponible

### Protección principal
Switch global para activar o desactivar toda la extensión. Cuando está desactivada, no se bloquea ninguna pestaña.

### Sitios protegidos
Lista de dominios donde se aplica la protección. Por defecto está vacía: el usuario agrega los dominios que necesite.

- **Agregar** un dominio: escribirlo sin protocolo (p.ej. `app.empresa.com`) y hacer clic en "+ Agregar sitio".
- **Activar/desactivar** cada dominio individualmente con su switch.
- **Eliminar** un dominio con el botón ×.

La extensión también protege subdominios. Si agregás `empresa.com`, también cubrirá `app.empresa.com`.

### Modo de detección

| Modo | Qué compara | Ejemplo |
|------|-------------|---------|
| **URL exacta** (predeterminado) | Protocolo + dominio + ruta + parámetros + hash | `?id=1` ≠ `?id=2` → NO son duplicadas |
| **Misma página ignorando parámetros** | Protocolo + dominio + ruta | `?id=1` == `?id=2` → SÍ son duplicadas |

### Al detectar un duplicado

- **Cerrar duplicada y volver a la original** (predeterminado): cierre inmediato.
- **Mostrar advertencia antes de cerrar**: notificación con botones. Si no se toma ninguna acción en 8 segundos, la pestaña se cierra automáticamente.

### Notificaciones
Muestra un aviso del sistema cuando se bloquea una pestaña. El aviso incluye el botón "Ir a la pestaña existente".

### Estadísticas
Contador local de pestañas duplicadas bloqueadas. Se puede restablecer en cualquier momento.

---

## Cómo funciona internamente

La extensión escucha tres eventos de Chrome:

| Evento | Qué detecta |
|--------|-------------|
| `tabs.onCreated` | Nueva pestaña con URL ya asignada al momento de creación |
| `tabs.onUpdated` | Cambio de URL dentro de una pestaña existente (navegación, pegar URL, favoritos, historial, F5) |
| `tabs.onRemoved` | Cierre de pestaña (para limpiar estado interno) |

Al instalar la extensión o al arrancar Chrome, también revisa las pestañas ya abiertas y cierra duplicados de forma determinista: conserva la de **menor ID** (la más antigua) y cierra las demás.

**Normalización de URLs:**

```
clave = protocolo + dominio + ruta (sin trailing slash) [+ query + hash en modo exacto]
```

Los trailing slashes se normalizan: `/page/` y `/page` se tratan como la misma ruta.

---

## Casos de uso

- ERPs y CRMs con sesiones únicas por pantalla
- Aplicaciones de facturación o gestión donde abrir la misma pantalla dos veces genera conflictos
- Herramientas internas con flujos de trabajo críticos
- Cualquier sitio web donde querés evitar confusión entre pestañas repetidas

---

## Cómo probarlo

### Caso 1 — URLs distintas (deben convivir)
1. Abrí `https://app.empresa.com/seccion-a`
2. Abrí `https://app.empresa.com/seccion-b`
3. ✅ Ambas deben permanecer abiertas.

### Caso 2 — Duplicar una pestaña
1. Tenés una pestaña abierta con una URL de un sitio protegido.
2. Hacé clic derecho → **Duplicar** (o abrí la misma URL en una pestaña nueva).
3. ✅ La nueva pestaña se cierra y se activa la original.

### Caso 3 — Sitios no protegidos (no deben verse afectados)
1. Abrí Google, YouTube, cualquier sitio que no esté en la lista.
2. ✅ La extensión no interviene.

### Caso 4 — Desactivar protección
1. Desactivá la protección desde la configuración.
2. Abrí pestañas duplicadas de un sitio protegido.
3. ✅ Ambas quedan abiertas.

### Caso 5 — Modo "ignorar parámetros"
1. Configurá "Misma página ignorando parámetros".
2. Abrí `https://app.empresa.com/pagina?id=1` y luego `https://app.empresa.com/pagina?id=2`.
3. ✅ La segunda se detecta como duplicada y se cierra.

### Caso 6 — Reiniciar Chrome con pestañas duplicadas
1. Abrí dos pestañas duplicadas de un sitio protegido.
2. Cerrá Chrome (Chrome guarda las pestañas).
3. Volvé a abrirlo.
4. ✅ La extensión detecta y cierra el duplicado en los primeros segundos.

---

## Privacidad y seguridad

- No envía datos a ningún servidor.
- No recopila historial de navegación ni URLs.
- No usa analytics ni tracking.
- No incluye código remoto ni `eval()`.
- Toda la información permanece en el navegador local.
- Compatible con las políticas de Chrome Web Store.

---

## Permisos

| Permiso | Motivo |
|---------|--------|
| `tabs` | Leer URLs de pestañas, cerrarlas, activarlas y consultar todas las abiertas |
| `storage` | Persistir configuración (`storage.sync`) y estadísticas (`storage.local`) |
| `notifications` | Mostrar aviso cuando se bloquea una pestaña duplicada |
| `windows` | Enfocar la ventana que contiene la pestaña original |

---

## Estructura del proyecto

```
dualblock/
├── manifest.json      ← Configuración (Manifest V3)
├── background.js      ← Service Worker: lógica de detección y cierre
├── options.html       ← Página de configuración
├── options.css        ← Estilos (modo claro y oscuro)
├── options.js         ← Lógica de la UI de configuración
├── icons/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

---

## Limitaciones conocidas de Chrome

| Limitación | Impacto |
|------------|---------|
| Chrome no permite cancelar la creación de una pestaña antes de que exista | La extensión la cierra inmediatamente después; el parpadeo es mínimo (fracción de segundo) |
| Los service workers (MV3) pueden ser terminados por Chrome en cualquier momento | Los timers del modo "advertencia" no sobreviven si el SW se reinicia; la pestaña queda abierta (comportamiento conservador) |
| `tabs.onUpdated` no captura todos los cambios SPA via `history.pushState` en todos los contextos | En apps con navegación de página completa esto no es relevante |
| Botones en notificaciones pueden no aparecer en todos los sistemas operativos | El timer de 8 segundos cierra la pestaña automáticamente de todas formas |

---

## Versión

**1.0.0** — Versión inicial
