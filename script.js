/**
 * Horario Académico & Centro de Control — script.js
 * ------------------------------------------------------------------
 * Arquitectura (ES6+, sin build tools):
 *  - Store único como fuente de verdad. Persistencia dual:
 *      · Invitado    → memoria (datos por defecto) + localStorage.
 *      · Autenticado → Firestore en tiempo real, documento users/{uid}.
 *    La migración local→nube es automática en el primer inicio de sesión.
 *  - Firebase Auth (Google) + Firestore v10+ cargados como ES modules
 *    desde gstatic, de forma perezosa y tolerante a fallos de red.
 *  - Puerta de escritura: cualquier mutación en modo invitado lanza el
 *    inicio de sesión con Google y la acción se aplica al autenticarse.
 *  - Datos maestros inmutables (Object.freeze) y helpers puros.
 *  - Render mediante builders que devuelven nodos y se insertan por lotes
 *    con DocumentFragment / replaceChildren (menos reflows, sin innerHTML
 *    con datos dinámicos → immune a XSS por contenido del usuario).
 *  - Accesibilidad: trampa de foco en modales y sidebar, restauración de
 *    foco, pestañas ARIA con flechas, regiones live, Escape para cerrar.
 *  - Funcionalidad nueva: edición/creación de asignaturas, exportación e
 *    importación JSON, barra de progreso de faltas, vista móvil del
 *    horario en acordeón y tema persistente con transición suave.
 */
(() => {
    'use strict';

    /* ============================== Utilidades puras ============================== */

    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
    const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

    /** Creador declarativo de elementos (textContent, nunca innerHTML con datos). */
    const el = (tag, { className = '', text = '', attrs = {}, dataset = {}, children = [] } = {}) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text) node.textContent = text;
        for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
        for (const [k, v] of Object.entries(dataset)) node.dataset[k] = v;
        for (const child of children) if (child) node.appendChild(child);
        return node;
    };

    const svgIcon = (inner) => {
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('class', 'svg-icon');
        svg.innerHTML = inner; // solo constantes internas, nunca input de usuario
        return svg;
    };

    /** Fecha local YYYY-MM-DD (evita el desfase UTC de toISOString). */
    const getLocalDateString = (date = new Date()) => {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    };

    const timeToMinutes = (timeStr) => {
        const [h, m] = timeStr.split(':').map(Number);
        return h * 60 + m;
    };

    /** Inverso de timeToMinutes: 990 → "16:30". */
    const minutesToTime = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

    /** Comparación insensible a mayúsculas y acentos para búsquedas. */
    const normalize = (str) => String(str).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

    /**
     * Semanas lectivas entre dos fechas YYYY-MM-DD: se cuenta la semana (lun-dom)
     * de la fecha de inicio y todas las que empiezan después hasta el final.
     * P. ej. 14-sep (lunes) → 13-nov: 9 semanas completas.
     */
    const teachingWeeks = ({ start, end }) => {
        const s = new Date(`${start}T00:00:00`);
        const e = new Date(`${end}T00:00:00`);
        const day = s.getDay();
        const mondayOffset = day === 0 ? 6 : day - 1;
        const firstMonday = new Date(s);
        firstMonday.setDate(s.getDate() - mondayOffset);
        const weeks = Math.floor((e - firstMonday) / (7 * 86400000)) + 1;
        return Math.max(0, weeks);
    };

    /* ============================== Datos maestros ============================== */

    const DAYS = Object.freeze([
        { id: 1, name: 'Lunes', weekend: false },
        { id: 2, name: 'Martes', weekend: false },
        { id: 3, name: 'Miércoles', weekend: false },
        { id: 4, name: 'Jueves', weekend: false },
        { id: 5, name: 'Viernes', weekend: false },
        { id: 6, name: 'Sábado', weekend: true },
        { id: 0, name: 'Domingo', weekend: true },
    ]);
    const WEEKDAYS = Object.freeze([1, 2, 3, 4, 5]);
    const dayDef = (id) => DAYS.find(d => d.id === id);

    const SLOTS = Object.freeze([
        { num: 1, start: '08:30', end: '09:25' },
        { num: 2, start: '09:25', end: '10:20' },
        { num: 3, start: '10:40', end: '11:35' },
        { num: 4, start: '11:35', end: '12:30' },
        { num: 5, start: '12:40', end: '13:35' },
        { num: 6, start: '13:35', end: '14:30' },
    ]);

    const BREAKS = Object.freeze([
        { row: 4, name: 'Recreo', start: '10:20', end: '10:40' },
        { row: 7, name: 'Descanso', start: '12:30', end: '12:40' },
    ]);

    /** Bloques de dos franjas contiguas que pueden fusionarse en una tarjeta. */
    const SCHEDULE_BLOCKS = Object.freeze([
        { row1: 2, row2: 3, slots: [1, 2] },
        { row1: 5, row2: 6, slots: [3, 4] },
        { row1: 8, row2: 9, slots: [5, 6] },
    ]);

    const GRID_ROWS = Object.freeze([
        { row: 2, label: '08:30 - 09:25' },
        { row: 3, label: '09:25 - 10:20' },
        { row: 4, label: '10:20 - 10:40' },
        { row: 5, label: '10:40 - 11:35' },
        { row: 6, label: '11:35 - 12:30' },
        { row: 7, label: '12:30 - 12:40' },
        { row: 8, label: '12:40 - 13:35' },
        { row: 9, label: '13:35 - 14:30' },
    ]);

    const COLOR_KEYS = Object.freeze([
        'montaje', 'prog', 'sor', 'servicios', 'web', 'ipe',
        'proyectos', 'sostenibilidad', 'digitalizacion',
    ]);

    const COLOR_LABELS = Object.freeze({
        montaje: 'Azul',
        prog: 'Ámbar',
        sor: 'Verde',
        servicios: 'Violeta',
        web: 'Rosa',
        ipe: 'Turquesa',
        proyectos: 'Naranja',
        sostenibilidad: 'Índigo',
        digitalizacion: 'Fucsia',
    });

    const DEFAULT_TEACHERS = Object.freeze({
        'Montaje y Mantenimiento': 'María Manchado',
        'Programación': 'Marisol Casado',
        'Sistemas Operativos en Red': 'Manuel Manchado',
        'IPE II': 'Manuel Manchado',
        'Servicios en Red': 'Saúl González',
        'Aplicaciones Web': 'Marisol Casado',
        'Proyecto Intermodular': 'María Manchado',
        'Digitalización': 'Marisol Casado',
        'Sostenibilidad': 'Manuel Manchado',
    });

    const DEFAULT_SCHEDULE = Object.freeze({
        '1-1': { name: 'Montaje y Mantenimiento', colorKey: 'montaje' },
        '1-2': { name: 'Montaje y Mantenimiento', colorKey: 'montaje' },
        '1-3': { name: 'Programación', colorKey: 'prog' },
        '1-4': { name: 'Sistemas Operativos en Red', colorKey: 'sor' },
        '1-5': { name: 'IPE II', colorKey: 'ipe' },
        '1-6': { name: 'Servicios en Red', colorKey: 'servicios' },

        '2-1': { name: 'Sistemas Operativos en Red', colorKey: 'sor' },
        '2-2': { name: 'Programación', colorKey: 'prog' },
        '2-3': { name: 'Servicios en Red', colorKey: 'servicios' },
        '2-4': { name: 'Servicios en Red', colorKey: 'servicios' },
        '2-5': { name: 'Aplicaciones Web', colorKey: 'web' },
        '2-6': { name: 'Proyecto Intermodular', colorKey: 'proyectos' },

        '3-1': { name: 'Montaje y Mantenimiento', colorKey: 'montaje' },
        '3-2': { name: 'Montaje y Mantenimiento', colorKey: 'montaje' },
        '3-3': { name: 'Aplicaciones Web', colorKey: 'web' },
        '3-4': { name: 'Aplicaciones Web', colorKey: 'web' },
        '3-5': { name: 'IPE II', colorKey: 'ipe'},
        '3-6': { name: 'Sostenibilidad', colorKey: 'sostenibilidad' },

        '4-1': { name: 'Digitalización', colorKey: 'digitalizacion' },
        '4-2': { name: 'Sistemas Operativos en Red', colorKey: 'sor' },
        '4-3': { name: 'IPE II', colorKey: 'ipe' },
        '4-4': { name: 'Servicios en Red', colorKey: 'servicios' },
        '4-5': { name: 'Montaje y Mantenimiento', colorKey: 'montaje' },
        '4-6': { name: 'Programación', colorKey: 'prog' },

        '5-1': { name: 'Aplicaciones Web', colorKey: 'web' },
        '5-2': { name: 'Sistemas Operativos en Red', colorKey: 'sor' },
        '5-3': { name: 'Sistemas Operativos en Red', colorKey: 'sor' },
        '5-4': { name: 'Montaje y Mantenimiento', colorKey: 'montaje' },
        '5-5': { name: 'Servicios en Red', colorKey: 'servicios' },
        '5-6': { name: 'Servicios en Red', colorKey: 'servicios' },
    });

    const GENERAL_RESOURCES = Object.freeze([
        {
            title: '🎓 Aula Virtual Moodle',
            description: 'Plataforma oficial del IES Donoso Cortés para entregas de tareas y recursos de clase.',
            url: 'https://moodle.educarex.es/iesdonosocortes/login/index.php',
        },
        {
            title: '📗 Google Classroom',
            description: 'Espacio de trabajo directo para comunicación con el profesorado.',
            url: 'https://classroom.google.com/u/1/h/st',
        },
        {
            title: '📖 Libro de Referencia SOR (SomeBooks)',
            description: 'Manual completo de la 2ª Edición para Sistemas Operativos en Red.',
            url: 'https://somebooks.es/sistemas-operativos-red-2a-edicion/',
        },
        {
            title: '📄 Visor de Apuntes PDF (FlipHTML5)',
            description: 'Documentación interactiva y unidades didácticas complementarias.',
            url: 'https://online.fliphtml5.com/bxagq/gell/#p=1',
        },
    ]);

    /* ===================== Cálculo real del límite de faltas =====================
     * 1er trimestre de FP (Don Benito, Extremadura): del lunes 14-sep al viernes
     * 13-nov. Límite = 15 % de las horas REALES impartidas en el trimestre:
     * horas semanales del módulo × semanas lectivas − horas de festivos.
     */
    const TERM_1 = Object.freeze({
        start: '2026-09-14',
        end: '2026-11-13',
        percent: 0.15,
        label: '1er trimestre (14 sep – 13 nov)',
        // Festivos no lectivos dentro del trimestre (Don Benito / Extremadura):
        // Fiesta Nacional (12-oct) y Todos los Santos (1-nov).
        holidays: Object.freeze(['2026-10-12', '2026-11-01']),
    });

    /* ===================== Firebase (Auth + Firestore, ES modules CDN) =====================
     * SDK v10+ cargado como módulos ES nativos desde gstatic (sin build tools).
     * Sustituye los placeholders por la configuración real de tu proyecto en
     * https://console.firebase.google.com → Project settings → Your apps.
     */
    const firebaseConfig = {
    apiKey: "AIzaSyCK3T2envUOdknnAsysFo8X9K0MHCq34Z0",
    authDomain: "horario-7bc33.firebaseapp.com",
    projectId: "horario-7bc33",
    storageBucket: "horario-7bc33.firebasestorage.app",
    messagingSenderId: "784946864452",
    appId: "1:784946864452:web:893c91ca787617f635b711",
    measurementId: "G-FP7DHF54FH"
    };

    const FIREBASE_ENABLED = !/YOUR_/.test(firebaseConfig.apiKey);

    /**
     * Fachada del SDK de Firebase: importa dinámicamente los ES modules de
     * gstatic una sola vez y expone las operaciones que usa la app
     * (Auth con Google y documento users/{uid} en Firestore).
     */
    const CloudSvc = {
        ready: false,
        auth: null,
        db: null,
        authApi: null,
        fsApi: null,
        initPromise: null,

        init() {
            if (this.initPromise) return this.initPromise;
            this.initPromise = (async () => {
                const appMod = await import('https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js');
                const authMod = await import('https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js');
                const fsMod = await import('https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js');
                const app = appMod.initializeApp(firebaseConfig);
                this.auth = authMod.getAuth(app);
                this.db = fsMod.getFirestore(app);
                this.authApi = authMod;
                this.fsApi = fsMod;
                this.ready = true;
            })();
            return this.initPromise;
        },

        async ensureReady() {
            if (FIREBASE_ENABLED && !this.ready) await this.init();
            return this.ready;
        },

        async signIn() {
            if (!(await this.ensureReady())) {
                window.alert('La sincronización en la nube no está configurada: edita firebaseConfig en script.js con los datos de tu proyecto Firebase.');
                return null;
            }
            const provider = new this.authApi.GoogleAuthProvider();
            provider.setCustomParameters({ prompt: 'select_account' });
            const cred = await this.authApi.signInWithPopup(this.auth, provider);
            return cred.user;
        },

        async signOut() {
            if (!this.ready) return;
            await this.authApi.signOut(this.auth);
        },

        /** Documento del usuario autenticado: users/{uid}. */
        userDoc(uid) {
            return this.fsApi.doc(this.db, 'users', uid);
        },

        async fetchUserDoc(uid) {
            const snap = await this.fsApi.getDoc(this.userDoc(uid));
            return snap.exists() ? snap.data() : null;
        },

        /** Escritura atómica de TODO el estado del Store en users/{uid}. */
        async saveUserDoc(uid, data) {
            await this.fsApi.setDoc(this.userDoc(uid), { ...data, syncedAt: new Date().toISOString() }, { merge: true });
        },

        /** Borrado total del documento (restaurar horario original estando autenticado). */
        async deleteUserDoc(uid) {
            await this.fsApi.deleteDoc(this.userDoc(uid));
        },
    };

    /*
     * Actividades fuera de la jornada lectiva ("Extraescolares"): horario
     * 100 % libre definido por el usuario (hora inicio/fin con <input type="time">).
     * Única regla dura: en L-V no pueden invadir la jornada presencial
     * 08:30-14:30; en fin de semana (sáb/dom) no hay restricción horaria.
     */
    const JORNADA = Object.freeze({ startMins: 8 * 60 + 30, endMins: 14 * 60 + 30 });

    /**
     * Regla estricta de recursos por docente:
     *  - Marisol Casado  → SOLO Google Classroom.
     *  - Resto           → SOLO Aula Virtual Moodle.
     */
    const isMarisolTeacher = (teacherName) =>
        /marisol/i.test(String(teacherName || ''));

    const resourcesForTeacher = (teacherName) => GENERAL_RESOURCES.filter(res =>
        isMarisolTeacher(teacherName)
            ? res.title.includes('Google Classroom')
            : res.title.includes('Aula Virtual Moodle'),
    );

    /* ============================== Store (estado + persistencia) ============================== */

    const SCHEMA_VERSION = 1;
    const STORAGE_KEY = 'academic_dashboard_v1';
    const THEME_KEY = 'academic_theme';

    /* --- Saneadores puros del estado, compartidos por localStorage y Firestore --- */

    const storeDefaults = () => ({
        version: SCHEMA_VERSION,
        schedule: JSON.parse(JSON.stringify(DEFAULT_SCHEDULE)),
        teachers: { ...DEFAULT_TEACHERS },
        tasks: [],
        absences: {},
        // { "día|slotKey": { name, teacher, colorKey } } — turno de tarde
        extracurricular: {},
    });

    const readLegacyArray = (key) => {
        try {
            const parsed = JSON.parse(localStorage.getItem(key) || 'null');
            return Array.isArray(parsed) ? parsed.filter(isValidTask).map(normalizeTask) : [];
        } catch { return []; }
    };

    const readLegacyMap = (key) => {
        try {
            const parsed = JSON.parse(localStorage.getItem(key) || 'null');
            return isObject(parsed) ? sanitizeAbsences(parsed) : {};
        } catch { return {}; }
    };

    const isValidTask = (t) => isObject(t) && typeof t.subject === 'string' && typeof t.text === 'string';

    const normalizeTask = (t) => ({
        id: Number.isFinite(t.id) ? t.id : Date.now() + Math.floor(Math.random() * 1e6),
        subject: String(t.subject).slice(0, 120),
        text: String(t.text).slice(0, 300),
        type: ['Tarea', 'Examen', 'Entrega'].includes(t.type) ? t.type : 'Tarea',
        date: /^\d{4}-\d{2}-\d{2}$/.test(t.date || '') ? t.date : getLocalDateString(),
        done: Boolean(t.done),
    });

    const isValidGrade = (g) => isObject(g) && typeof g.subject === 'string' && typeof g.name === 'string' && Number.isFinite(Number(g.value));

    const normalizeGrade = (g) => ({
        id: Number.isFinite(g.id) ? g.id : Date.now() + Math.floor(Math.random() * 1e6),
        subject: String(g.subject).slice(0, 120),
        name: String(g.name).slice(0, 120),
        value: clamp(Number(g.value), 0, 10),
    });

    const sanitizeAbsences = (absences) => {
        const out = {};
        for (const [k, v] of Object.entries(absences)) {
            const n = Number(v);
            if (typeof k === 'string' && k && Number.isFinite(n)) out[k.slice(0, 120)] = clamp(Math.floor(n), 0, 999);
        }
        return out;
    };

    const sanitizeTeachers = (teachers) => {
        const out = {};
        for (const [k, v] of Object.entries(teachers)) {
            if (typeof k === 'string' && k && typeof v === 'string' && v.trim()) out[k.slice(0, 120)] = v.trim().slice(0, 120);
        }
        return out;
    };

    const sanitizeSchedule = (schedule) => {
        const out = {};
        for (const [key, value] of Object.entries(schedule)) {
            if (!/^[1-5]-[1-6]$/.test(key) || !isObject(value)) continue;
            const name = typeof value.name === 'string' ? value.name.trim() : '';
            if (!name) continue;
            out[key] = { name: name.slice(0, 120), colorKey: COLOR_KEYS.includes(value.colorKey) ? value.colorKey : 'montaje' };
        }
        return out;
    };

    /** Valida UNA actividad fuera de jornada; devuelve el objeto limpio o null. */
    const sanitizeExtraEntry = (value) => {
        if (!isObject(value) || typeof value.name !== 'string' || !value.name.trim()) return null;
        const day = Number(value.day);
        if (!dayDef(day)) return null;
        const timeRe = /^\d{2}:\d{2}$/;
        const start = typeof value.start === 'string' && timeRe.test(value.start) ? value.start : null;
        const end = typeof value.end === 'string' && timeRe.test(value.end) ? value.end : null;
        if (!start || !end || timeToMinutes(start) >= timeToMinutes(end)) return null;
        return {
            day,
            start,
            end,
            name: value.name.trim().slice(0, 120),
            teacher: typeof value.teacher === 'string' ? value.teacher.trim().slice(0, 120) : '',
            colorKey: COLOR_KEYS.includes(value.colorKey) ? value.colorKey : 'montaje',
        };
    };

    /** Mapa completo saneado con claves "día|HH:MM". */
    const sanitizeExtracurricular = (extras) => {
        const out = {};
        for (const [key, value] of Object.entries(extras || {})) {
            let v = value;
            // Compatibilidad: el formato previo guardaba {name,teacher,colorKey}
            // con el día y la hora SOLO en la clave "día|HH:MM".
            if (isObject(v) && v.day === undefined) {
                const m = /^(\d)\|(\d{2}:\d{2})$/.exec(String(key));
                if (m) {
                    const endMins = timeToMinutes(m[2]) + 75; // duración de las antiguas franjas de tarde
                    v = { ...v, day: Number(m[1]), start: m[2], end: minutesToTime(Math.min(endMins, 24 * 60 - 1)) };
                }
            }
            const clean = sanitizeExtraEntry(v);
            if (clean) out[`${clean.day}|${clean.start}`] = clean;
        }
        return out;
    };

    /** Carga y sanea el estado local del invitado (migra el formato antiguo). */
    const loadStateFromLocal = (base) => {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);

            if (!raw) {
                // Sin estado nuevo: migra datos del formato antiguo si existen
                const oldTasks = readLegacyArray('academic_tasks');
                const oldAbsences = readLegacyMap('academic_absences');
                if (oldTasks.length || Object.keys(oldAbsences).length) {
                    // Limpia las claves antiguas tras la migración exitosa para que un
                    // futuro reset no "resucite" datos obsoletos en la siguiente carga.
                    try {
                        localStorage.removeItem('academic_tasks');
                        localStorage.removeItem('academic_absences');
                    } catch { /* noop */ }
                    return { ...base, tasks: oldTasks, absences: oldAbsences };
                }
                return base;
            }

            const parsed = JSON.parse(raw);
            if (!isObject(parsed)) return base;

            // Corrección de docencia (curso 26/27): Digitalización la imparte Marisol Casado.
            // Se aplica también a estados ya guardados para no perpetuar el dato antiguo
            // (si el usuario la cambió a mano a otro valor, se respeta su elección).
            if (isObject(parsed.teachers) && parsed.teachers['Digitalización'] === 'María Manchado') {
                parsed.teachers['Digitalización'] = 'Marisol Casado';
                try { localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed)); } catch { /* noop */ }
            }

            return {
                version: SCHEMA_VERSION,
                schedule: isObject(parsed.schedule) ? sanitizeSchedule(parsed.schedule) : base.schedule,
                teachers: isObject(parsed.teachers) ? sanitizeTeachers(parsed.teachers) : base.teachers,
                tasks: Array.isArray(parsed.tasks) ? parsed.tasks.filter(isValidTask).map(normalizeTask) : [],
                absences: isObject(parsed.absences) ? sanitizeAbsences(parsed.absences) : {},
                grades: Array.isArray(parsed.grades) ? parsed.grades.filter(isValidGrade).map(normalizeGrade) : [],
                extracurricular: isObject(parsed.extracurricular) ? sanitizeExtracurricular(parsed.extracurricular) : {},
            };
        } catch (err) {
            console.error('Store: estado corrupto, se restauran los valores por defecto.', err);
            return base;
        }
    };

    /**
     * Estado normalizado a partir del documento remoto users/{uid}.
     * Estructura idéntica a toJSON(): schedule, teachers, tasks, absences,
     * grades y extracurricular. Tolera documentos parciales o vacíos.
     */
    const storeStateFromDoc = (doc) => {
        const incoming = isObject(doc) ? doc : {};
        const base = storeDefaults();
        return {
            version: SCHEMA_VERSION,
            schedule: isObject(incoming.schedule) ? sanitizeSchedule(incoming.schedule) : base.schedule,
            teachers: isObject(incoming.teachers) ? sanitizeTeachers(incoming.teachers) : base.teachers,
            tasks: Array.isArray(incoming.tasks) ? incoming.tasks.filter(isValidTask).map(normalizeTask) : [],
            absences: isObject(incoming.absences) ? sanitizeAbsences(incoming.absences) : {},
            grades: Array.isArray(incoming.grades) ? incoming.grades.filter(isValidGrade).map(normalizeGrade) : [],
            extracurricular: isObject(incoming.extracurricular) ? sanitizeExtracurricular(incoming.extracurricular) : {},
        };
    };

    class Store {
        constructor() {
            this.isSynced = false; // false → invitado (localStorage) · true → Firestore (users/{uid})
            this.uid = null;
            this.state = loadStateFromLocal(storeDefaults());
        }

        /* --- Persistencia dual: localStorage (invitado) / Firestore (autenticado) --- */

        /** Invitado: recarga el estado desde localStorage. */
        loadLocal() {
            this.state = loadStateFromLocal(storeDefaults());
        }

        /** Persistencia local SOLO en invitado; autenticado, la nube es la fuente de verdad. */
        saveLocal() {
            if (this.isSynced) return;
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
            } catch (err) {
                console.error('Store: no se pudo guardar en localStorage (modo privado o cuota llena).', err);
            }
        }

        clearLocal() {
            try { localStorage.removeItem(STORAGE_KEY); } catch { /* noop */ }
        }

        /**
         * Reemplaza el estado completo por el documento remoto users/{uid} y
         * dispara 'store:change' para redibujar la app sin recargar la página.
         */
        applyRemote(remote) {
            this.state = storeStateFromDoc(remote);
            this.saveLocal();
            document.dispatchEvent(new CustomEvent('store:change'));
        }

        /** Aplica la mutación, persiste (local o nube) y refresca la UI. */
        commit(next) {
            this.state = { ...this.state, ...next };
            if (this.isSynced) this.pushRemote();
            this.saveLocal();
            document.dispatchEvent(new CustomEvent('store:change'));
        }

        /**
         * Sube TODO el estado actual a users/{uid}. Solo con sesión iniciada.
         * La estructura es idéntica a toJSON(): schedule, teachers, tasks,
         * absences, grades y extracurricular.
         */
        pushRemote() {
            if (!this.isSynced || !this.uid) return Promise.resolve();
            return CloudSvc.saveUserDoc(this.uid, {
                schedule: this.state.schedule,
                teachers: this.state.teachers,
                tasks: this.state.tasks,
                absences: this.state.absences,
                grades: this.state.grades,
                extracurricular: this.state.extracurricular,
            }).catch(err => console.error('Store: fallo al sincronizar con Firestore.', err));
        }

        /**
         * Puerta de escritura: en modo invitado detiene la mutación y lanza el
         * inicio de sesión con Google; tras autenticarse (migración o descarga
         * remota incluida) la mutación continúa y se guarda en Firestore.
         * @returns {Promise<boolean>} true si la mutación puede ejecutarse.
         */
        async requireWrite() {
            if (this.isSynced) return true;
            try {
                const user = await CloudSvc.signIn();
                if (!user) return false; // el usuario canceló el popup
                await AuthSync.sync(user, { force: true });
                return store.isSynced;
            } catch (err) {
                if (err && (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request')) return false;
                console.error('Auth: no se pudo iniciar sesión.', err);
                window.alert('No se pudo iniciar sesión con Google. Inténtalo de nuevo.');
                return false;
            }
        }

        /* --- Consultas --- */
        get tasks() { return this.state.tasks; }
        get schedule() { return this.state.schedule; }
        get teachers() { return this.state.teachers; }
        get extracurricular() { return this.state.extracurricular; }
        get grades() { return this.state.grades; }

        gradesFor(subject) {
            return this.state.grades.filter(g => g.subject === subject);
        }

        async addGrade(data) {
            if (!(await this.requireWrite())) return null; // invitado → login Google
            const grade = normalizeGrade({ ...data, id: Date.now() + Math.floor(Math.random() * 1e6) });
            this.commit({ grades: [...this.state.grades, grade] });
            return grade;
        }

        async removeGrade(id) {
            if (!(await this.requireWrite())) return; // invitado → login Google
            this.commit({ grades: this.state.grades.filter(g => g.id !== id) });
        }

        gradeStats(subject) {
            const list = this.gradesFor(subject);
            if (!list.length) return { average: null, count: 0 };
            const sum = list.reduce((acc, g) => acc + g.value, 0);
            return { average: sum / list.length, count: list.length };
        }

        getAbsences(subject) { return this.state.absences[subject] || 0; }
        getTeacher(subject) { return this.state.teachers[subject] || 'Sin asignar'; }

        tasksFor(subject) { return this.state.tasks.filter(t => t.subject === subject); }
        tasksOn(dateStr) { return this.state.tasks.filter(t => t.date === dateStr); }
        pendingTasksFor(subject) { return this.state.tasks.filter(t => t.subject === subject && !t.done); }

        /**
         * Cálculo REAL del límite de faltas del 1er trimestre (FP Don Benito):
         * horas semanales del módulo × semanas lectivas − horas de festivos,
         * y sobre ese total real se aplica el 15 %.
         * @returns {{weekly:number,weeks:number,weeksRaw:number,holidayHits:number,
         *   holidayHours:number,total:number,limit:number,percent:number}}
         */
        absenceStats(subject) {
            // a) horas lectivas semanales según el horario configurado (L-V, franjas 1-6)
            const weekly = Object.entries(this.state.schedule)
                .filter(([, v]) => v.name === subject)
                .map(([key]) => Number(key.split('-')[0]))
                .filter(day => day >= 1 && day <= 5)
                .length;

            const weeks = teachingWeeks(TERM_1);
            const msPerWeek = 7 * 86400000;
            const weeksRaw = Math.round((new Date(TERM_1.end) - new Date(TERM_1.start)) / msPerWeek);

            // b) festivos no lectivos dentro del trimestre (solo cuentan si caen L-V
            //    y el módulo tiene horas ese día de la semana)
            let holidayHours = 0;
            let holidayHits = 0;
            TERM_1.holidays.forEach(dstr => {
                const wd = new Date(`${dstr}T00:00:00`).getDay();
                if (wd < 1 || wd > 5 || !weekly) return;
                const hasThatDay = Object.entries(this.state.schedule)
                    .some(([key, v]) => v.name === subject && Number(key.split('-')[0]) === wd);
                if (hasThatDay) {
                    holidayHours += weekly;
                    holidayHits++;
                }
            });

            // c) horas reales impartidas y límite del 15 %
            const total = Math.max(0, weekly * weeks - holidayHours);
            return {
                weekly, weeks, weeksRaw,
                holidayHits, holidayHours,
                total,
                limit: Math.round(total * TERM_1.percent * 100) / 100,
                percent: TERM_1.percent,
            };
        }

        slotsOf(subject) {
            return Object.entries(this.state.schedule)
                .filter(([, v]) => v.name === subject)
                .map(([key, v]) => {
                    const [day, slot] = key.split('-').map(Number);
                    const dayDef = DAYS.find(d => d.id === day);
                    const slotDef = SLOTS.find(s => s.num === slot);
                    return {
                        day, slot,
                        dayName: dayDef ? dayDef.name : `Día ${day}`,
                        time: slotDef ? `${slotDef.start} - ${slotDef.end}` : '',
                    };
                })
                .sort((a, b) => a.day - b.day || a.slot - b.slot);
        }

        subjects() {
            const map = new Map();
            Object.values(this.state.schedule).forEach(({ name }) => {
                if (!map.has(name)) map.set(name, this.getTeacher(name));
            });
            return map;
        }

        /* --- Mutaciones (inmutables + persistencia atómica).
             Cada una pasa por requireWrite(): en modo invitado se detiene y
             lanza el login con Google; al autenticarse continúa en la nube. --- */
        async addTask(data) {
            if (!(await this.requireWrite())) return null; // invitado → login Google
            const task = normalizeTask({ ...data, id: Date.now() + Math.floor(Math.random() * 1e6) });
            this.commit({ tasks: [...this.state.tasks, task] });
            return task;
        }

        async removeTask(id) {
            if (!(await this.requireWrite())) return; // invitado → login Google
            this.commit({ tasks: this.state.tasks.filter(t => t.id !== id) });
        }

        async setTaskDone(id, done) {
            if (!(await this.requireWrite())) return; // invitado → login Google
            this.commit({ tasks: this.state.tasks.map(t => (t.id === id ? { ...t, done } : t)) });
        }

        async setAbsences(subject, count) {
            if (!(await this.requireWrite())) return; // invitado → login Google
            const absences = { ...this.state.absences };
            // Techo holgado: el límite real lo calcula absenceStats() (15 % del trimestre)
            absences[subject] = clamp(Math.round(count), 0, 99);
            this.commit({ absences });
        }

        async setSlot(day, slot, entry) {
            if (!(await this.requireWrite())) return false; // invitado → login Google
            const schedule = { ...this.state.schedule };
            const key = `${day}-${slot}`;
            if (entry && entry.name) schedule[key] = { name: entry.name.trim(), colorKey: entry.colorKey };
            else delete schedule[key];

            const teachers = { ...this.state.teachers };
            if (entry && entry.name && entry.teacher && entry.teacher.trim()) {
                teachers[entry.name.trim()] = entry.teacher.trim();
            }
            this.commit({ schedule, teachers });
            return true;
        }

        /** Renombra una asignatura en todas sus franjas y actualiza el profesor. */
        async renameSubject(oldName, newName, teacher) {
            if (!(await this.requireWrite())) return false; // invitado → login Google
            const schedule = {};
            Object.entries(this.state.schedule).forEach(([key, v]) => {
                schedule[key] = v.name === oldName ? { ...v, name: newName } : v;
            });
            const extracurricular = {};
            Object.values(this.state.extracurricular).forEach(v => {
                extracurricular[`${v.day}|${v.start}`] = v.name === oldName ? { ...v, name: newName } : v;
            });
            const teachers = { ...this.state.teachers };
            delete teachers[oldName];
            if (teacher && teacher.trim()) teachers[newName] = teacher.trim();
            this.commit({ schedule, extracurricular, teachers });
            return true;
        }

        /* --- Actividades fuera de jornada (horario libre) --- */
        async setExtra(entry) {
            const clean = sanitizeExtraEntry(entry);
            if (!clean) return false; // rechaza entradas inválidas en vez de guardar undefined
            if (!(await this.requireWrite())) return false; // invitado → login Google
            const extracurricular = { ...this.state.extracurricular };
            extracurricular[`${clean.day}|${clean.start}`] = clean;
            const teachers = { ...this.state.teachers };
            if (entry.teacher && entry.teacher.trim()) teachers[clean.name] = entry.teacher.trim();
            this.commit({ extracurricular, teachers });
            return true;
        }

        async removeExtra(day, start) {
            if (!(await this.requireWrite())) return false; // invitado → login Google
            const extracurricular = { ...this.state.extracurricular };
            delete extracurricular[`${day}|${start}`];
            this.commit({ extracurricular });
            return true;
        }

        /** Lista cronológica de extras (por día y hora). */
        extrasList() {
            // Orden cronológico real: L→V, Sábado y Domingo al final (id 0 → 7)
            const dayOrder = (d) => (d === 0 ? 7 : d);
            return Object.values(this.state.extracurricular)
                .filter(Boolean)
                .sort((a, b) => dayOrder(a.day) - dayOrder(b.day) || timeToMinutes(a.start) - timeToMinutes(b.start));
        }

        extrasOn(dayId) {
            return this.extrasList().filter(x => x.day === dayId);
        }

        async replaceAll(incoming) {
            if (!(await this.requireWrite())) return false; // invitado → login Google
            const base = storeDefaults();
            this.state = {
                version: SCHEMA_VERSION,
                schedule: isObject(incoming.schedule) ? sanitizeSchedule(incoming.schedule) : base.schedule,
                teachers: isObject(incoming.teachers) ? sanitizeTeachers(incoming.teachers) : base.teachers,
                tasks: Array.isArray(incoming.tasks) ? incoming.tasks.filter(isValidTask).map(normalizeTask) : [],
                absences: isObject(incoming.absences) ? sanitizeAbsences(incoming.absences) : {},
                grades: Array.isArray(incoming.grades) ? incoming.grades.filter(isValidGrade).map(normalizeGrade) : [],
                extracurricular: isObject(incoming.extracurricular) ? sanitizeExtracurricular(incoming.extracurricular) : {},
            };
            this.saveLocal();
            document.dispatchEvent(new CustomEvent('store:change'));
            return true;
        }

        /** Restaura los datos por defecto (invitado: local · autenticado: nube). */
        async resetAll() {
            if (!(await this.requireWrite())) return; // invitado → login Google
            if (this.isSynced && this.uid) {
                // El estado por defecto se reconstruye desde cero: se vacía el
                // documento remoto para no conservar datos obsoletos en la nube.
                try {
                    await CloudSvc.deleteUserDoc(this.uid);
                } catch (err) {
                    console.error('Store: no se pudo vaciar el documento remoto.', err);
                    window.alert('No se pudo restaurar en la nube. Inténtalo de nuevo.');
                    return;
                }
            }
            this.clearLocal();
            this.state = storeDefaults();
            if (!this.isSynced) this.saveLocal();
            document.dispatchEvent(new CustomEvent('store:change'));
        }

        toJSON() {
            return {
                version: SCHEMA_VERSION,
                exportedAt: new Date().toISOString(),
                schedule: this.state.schedule,
                teachers: this.state.teachers,
                tasks: this.state.tasks,
                absences: this.state.absences,
                grades: this.state.grades,
                extracurricular: this.state.extracurricular,
            };
        }
    }

    const store = new Store();

    /* ===================== Sincronización en la nube (migración + Firestore) ===================== */

    const AuthSync = {
        _inflight: null,
        authUnsub: null,

        /**
         * Flujo al autenticarse (idempotente: llamadas concurrentes comparten
         * la misma promesa):
         *  1. Descarga users/{uid}.
         *  2. Documento inexistente + clave local `academic_dashboard_v1` →
         *     migración automática: sube el estado local y borra la clave.
         *  3. Documento existente (o sin datos locales) → manda el remoto y
         *     se ignora el localStorage.
         */
        async sync(user, { force = false } = {}) {
            if (!force && store.isSynced && store.uid === user.uid) return;
            if (this._inflight) return this._inflight;
            this._inflight = this._syncInner(user).finally(() => { this._inflight = null; });
            return this._inflight;
        },

        async _syncInner(user) {
            try {
                const remote = await CloudSvc.fetchUserDoc(user.uid);
                const hadLocal = (() => { try { return Boolean(localStorage.getItem(STORAGE_KEY)); } catch { return false; } })();

                store.uid = user.uid;
                store.isSynced = true;

                if (!remote && hadLocal) {
                    // Migración automática: sube el estado local tal cual a users/{uid}
                    await CloudSvc.saveUserDoc(user.uid, {
                        schedule: store.state.schedule,
                        teachers: store.state.teachers,
                        tasks: store.state.tasks,
                        absences: store.state.absences,
                        grades: store.state.grades,
                        extracurricular: store.state.extracurricular,
                    });
                    // El spec exige eliminar la clave local tras subir con éxito
                    // para evitar futuras inconsistencias local/nube.
                    store.clearLocal();
                    console.info('AuthSync: estado local migrado a Firestore (users/%s).', user.uid);
                    document.dispatchEvent(new CustomEvent('store:change'));
                } else {
                    // Documento existente (o arranque en blanco): manda la nube
                    store.applyRemote(remote);
                }

                renderAuthUI();
                showAuthToast(!remote && hadLocal
                    ? 'Datos locales migrados a la nube ✓'
                    : 'Sesión iniciada: tus datos se guardan en la nube.');
            } catch (err) {
                store.isSynced = false;
                store.uid = null;
                renderAuthUI();
                throw err;
            }
        },

        /** Cierre de sesión: vuelve al modo invitado con sus datos locales. */
        async unsync() {
            try { await CloudSvc.signOut(); } catch (err) { console.error('Auth: fallo al cerrar sesión.', err); }
            store.isSynced = false;
            store.uid = null;
            store.loadLocal();
            renderAuthUI();
            showAuthToast('Sesión cerrada: modo invitado (los cambios requieren iniciar sesión).');
        },

        /** Arranque: restaura la sesión previa (Auth persiste la sesión por defecto). */
        async boot() {
            if (!FIREBASE_ENABLED) {
                renderAuthUI();
                return;
            }
            try {
                await CloudSvc.init();
            } catch (err) {
                console.error('Firebase: no se pudo inicializar (¿sin conexión o configuración inválida?).', err);
                renderAuthUI();
                return;
            }
            this.authUnsub = CloudSvc.authApi.onAuthStateChanged(CloudSvc.auth, (user) => {
                if (user) {
                    this.sync(user).catch(err => console.error('AuthSync: fallo al sincronizar con Firestore.', err));
                } else {
                    store.isSynced = false;
                    store.uid = null;
                    renderAuthUI();
                }
            });
        },
    };

    /* ============================== Estado de la UI ============================== */

    const ui = {
        viewMode: 'weekly',
        selectedDayIndex: (() => {
            const d = new Date().getDay();
            return d >= 1 && d <= 5 ? d : 1;
        })(),
        currentActiveSubject: null,
        activeSlot: null,          // { dayId, slotNum } del último detalle lectivo abierto
        activeExtra: null,         // { day, start } del último detalle fuera de jornada abierto
        currentCalDate: new Date(),
        selectedCalDayStr: getLocalDateString(),
        editingKey: null,          // `${day}-${slot}` lectivo en edición, o null si es alta nueva
        editingExtra: null,        // `{day, start}` fuera de jornada en edición, o null si es alta
        pendingExtraTarget: null,  // destino provisional para altas fuera de jornada
        sidebarOpen: false,
        expandedMobileDays: new Set([new Date().getDay()].filter(d => d >= 1 && d <= 5)),
    };

    /* ============================== Referencias DOM ============================== */

    const dom = {
        liveDatetime: $('#live-datetime'),
        statusBadge: $('#status-badge'),
        statusText: $('#status-text'),
        btnTheme: $('#btn-theme'),
        themeIcon: $('#theme-icon-svg'),

        btnToggleSidebar: $('#btn-toggle-sidebar'),
        btnCloseSidebar: $('#btn-close-sidebar'),
        sidebar: $('#sidebar'),
        sidebarOverlay: $('#sidebar-overlay'),
        navItems: $$('.nav-item'),
        appViews: $$('.app-view'),
        btnPrint: $('#btn-print'),
        btnAddSubject: $('#btn-add-subject'),
        btnExport: $('#btn-export'),
        btnExportIcs: $('#btn-export-ics'),
        btnImport: $('#btn-import'),
        importFile: $('#import-file'),
        btnReset: $('#btn-reset'),

        wrapper: $('#schedule-wrapper'),
        extrasSection: $('#extras-section'),
        extrasGrid: $('#extras-grid'),
        btnWeekly: $('#btn-weekly'),
        btnDaily: $('#btn-daily'),
        daySelect: $('#day-select'),

        calendarDatesGrid: $('#calendar-dates-grid'),
        calendarMonthYear: $('#calendar-month-year'),
        btnPrevMonth: $('#btn-prev-month'),
        btnNextMonth: $('#btn-next-month'),
        calendarTasksContainer: $('#calendar-tasks-container'),
        selectedDayTitle: $('#selected-day-title'),

        teachersIndexList: $('#teachers-index-list'),
        subjectsIndexList: $('#subjects-index-list'),
        directorySearch: $('#directory-search'),
        indexTabBtns: $$('#directory-view .tab-btn'),
        indexTabContents: $$('#directory-view .tab-content'),

        generalResourcesGrid: $('#general-resources-grid'),
        resourcesSearch: $('#resources-search'),

        modal: $('#detail-modal'),
        modalClose: $('#modal-close'),
        modalCard: $('#detail-modal .modal-card'),
        modalTag: $('#modal-tag'),
        modalTitle: $('#modal-title'),
        modalTeacher: $('#modal-teacher'),
        modalTime: $('#modal-time'),
        modalStatus: $('#modal-status'),
        modalResourcesList: $('#modal-resources-list'),
        modalTabHeaders: $('#modal-tab-headers'),
        rowTeacher: $('#row-teacher'),
        modalResourcesRow: $('#modal-resources-row'),
        tabBtns: $$('#detail-modal .tab-btn'),
        tabContents: $$('#detail-modal .tab-content'),
        tabTaskCount: $('#tab-task-count'),
        btnEditSubject: $('#btn-edit-subject'),

        taskForm: $('#task-form'),
        taskInput: $('#task-input'),
        taskType: $('#task-type'),
        taskDate: $('#task-date'),
        taskList: $('#task-list'),
        btnAddAbsence: $('#btn-add-absence'),
        btnSubAbsence: $('#btn-sub-absence'),
        absenceCountDisplay: $('#absence-count-display'),
        absenceProgress: $('#absence-progress'),
        absenceProgressFill: $('#absence-progress-fill'),
        absenceProgressLabel: $('#absence-progress-label'),
        absenceTrimesterInfo: $('#absence-trimester-info'),

        gradeForm: $('#grade-form'),
        gradeName: $('#grade-name'),
        gradeValue: $('#grade-value'),
        gradeList: $('#grade-list'),
        gradeAverageDisplay: $('#grade-average-display'),
        gradeNeededDisplay: $('#grade-needed-display'),

        editorModal: $('#subject-editor-modal'),
        editorClose: $('#editor-close'),
        editorTag: $('#editor-tag'),
        editorTitle: $('#editor-title'),
        editorForm: $('#subject-form'),
        subjectName: $('#subject-name'),
        subjectTeacher: $('#subject-teacher'),
        subjectDay: $('#subject-day'),
        subjectSlot: $('#subject-slot'),
        subjectSlotField: $('#subject-slot-field'),
        subjectSlotLabel: $('#subject-slot-label'),
        subjectTimes: $('#subject-times'),
        subjectStart: $('#subject-start'),
        subjectEnd: $('#subject-end'),
        subjectColor: $('#subject-color'),
        editorError: $('#editor-error'),
        btnDeleteSlot: $('#btn-delete-slot'),
        btnEditorCancel: $('#btn-editor-cancel'),

        // Autenticación (header)
        authArea: $('#auth-area'),
        btnLoginGoogle: $('#btn-login-google'),
        userChip: $('#user-chip'),
        userAvatar: $('#user-avatar'),
        userFallback: $('#user-fallback'),
        userName: $('#user-name'),
        userEmail: $('#user-email'),
        btnLogout: $('#btn-logout'),
        authToast: $('#auth-toast'),
    };

    /* ============================== Gestión de foco ============================== */

    const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

    const FocusManager = {
        stack: [],
        open(container) {
            this.stack.push({ container, restoreTo: document.activeElement });
            const target = container.querySelector('[data-autofocus]') || container.querySelector(FOCUSABLE);
            if (target) target.focus({ preventScroll: true });
        },
        close() {
            const entry = this.stack.pop();
            if (entry?.restoreTo && typeof entry.restoreTo.focus === 'function') {
                entry.restoreTo.focus({ preventScroll: true });
            }
        },
        /** Cicla el Tab dentro del contenedor activo (trampa de foco). */
        trapKeydown(e) {
            if (e.key !== 'Tab' || !this.stack.length) return;
            const container = this.stack[this.stack.length - 1].container;
            const focusables = [...container.querySelectorAll(FOCUSABLE)]
                .filter(n => n.offsetParent !== null || n === document.activeElement);
            if (!focusables.length) return;
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        },
    };

    /** Oculta el resto de la página con `inert` mientras el overlay esté abierto. */
    function setMainInert(value) {
        ['header.app-header', 'main.main-content', 'footer.app-footer'].forEach(sel => {
            const node = document.querySelector(sel);
            if (!node) return;
            if (value) node.setAttribute('inert', '');
            else node.removeAttribute('inert');
        });
    }

    function openOverlay(container) {
        container.classList.add('active');
        container.setAttribute('aria-hidden', 'false');
        setMainInert(true);
        FocusManager.open(container);
    }

    function closeOverlay(container) {
        if (!container.classList.contains('active')) return;
        container.classList.add('closing');
        const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 200;
        setTimeout(() => {
            container.classList.remove('active', 'closing');
            setMainInert(false);          // 1º: reactivar el fondo para que pueda recibir el foco
            FocusManager.close();         // 2º: devolver el foco fuera del overlay
            container.setAttribute('aria-hidden', 'true'); // 3º: recién sin foco dentro, ocultar
        }, duration);
    }

    /* ============================== Sidebar ============================== */

    function openSidebar() {
        if (ui.sidebarOpen) return;
        ui.sidebarOpen = true;
        dom.sidebarOverlay.classList.add('active');
        dom.btnToggleSidebar.setAttribute('aria-expanded', 'true');
        openOverlay(dom.sidebar);
    }

    function closeSidebar({ restoreFocus = false } = {}) {
        if (!ui.sidebarOpen) return;
        ui.sidebarOpen = false;
        dom.sidebarOverlay.classList.remove('active');
        dom.btnToggleSidebar.setAttribute('aria-expanded', 'false');
        closeOverlay(dom.sidebar);
        if (restoreFocus) dom.btnToggleSidebar.focus({ preventScroll: true });
    }

    /* ============================== Pestañas ARIA (con flechas) ============================== */

    function setupTablist(tabBtns, tabContents, getKey) {
        const select = (key, { focus = false } = {}) => {
            tabBtns.forEach(btn => {
                const isActive = getKey(btn) === key;
                btn.classList.toggle('active', isActive);
                btn.setAttribute('aria-selected', String(isActive));
                btn.tabIndex = isActive ? 0 : -1;
            });
            tabContents.forEach(content => {
                const show = getKey({ dataset: {}, id: content.id }) ? false : true; // placeholder, ver abajo
                void show;
            });
            // Empareja panel por aria-controls del botón activo (fuente única de verdad)
            const activeBtn = tabBtns.find(b => getKey(b) === key);
            const panelId = activeBtn?.getAttribute('aria-controls');
            tabContents.forEach(content => {
                const show = content.id === panelId;
                content.classList.toggle('active', show);
                if (show) content.removeAttribute('hidden');
                else content.setAttribute('hidden', '');
            });
            if (focus) activeBtn?.focus();
        };

        tabBtns.forEach((btn, i) => {
            btn.addEventListener('click', () => select(getKey(btn)));
            btn.addEventListener('keydown', (e) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
                e.preventDefault();
                let next = i;
                if (e.key === 'ArrowRight') next = (i + 1) % tabBtns.length;
                if (e.key === 'ArrowLeft') next = (i - 1 + tabBtns.length) % tabBtns.length;
                if (e.key === 'Home') next = 0;
                if (e.key === 'End') next = tabBtns.length - 1;
                select(getKey(tabBtns[next]), { focus: true });
            });
        });
        return select;
    }

    const selectModalTab = setupTablist(dom.tabBtns, dom.tabContents, b => b.dataset.tab);
    const selectIndexTab = setupTablist(dom.indexTabBtns, dom.indexTabContents, b => b.dataset.indextab);

    /* ============================== Estado en tiempo real ============================== */

    const cardStatus = (dayId, startStr, endStr) => {
        const now = new Date();
        const currentMins = now.getHours() * 60 + now.getMinutes();
        if (now.getDay() !== dayId) return 'Programada';
        if (currentMins >= timeToMinutes(startStr) && currentMins < timeToMinutes(endStr)) return 'En curso (ahora)';
        if (currentMins < timeToMinutes(startStr)) return 'Próxima hoy';
        return 'Finalizada hoy';
    };

    let lastMinuteTick = -1;

    function updateLiveTracker(force = false) {
        const now = new Date();
        dom.liveDatetime.textContent =
            `${now.toLocaleTimeString('es-ES')} | ${now.toLocaleDateString('es-ES', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' })}`;

        const currentMins = now.getHours() * 60 + now.getMinutes();
        if (!force && currentMins === lastMinuteTick) return; // el reloj corre cada segundo; el estado solo cambia por minuto
        lastMinuteTick = currentMins;

        const currentDay = now.getDay();
        let activeTitle = '';
        let remaining = 0;

        $$('.class-card', dom.wrapper).forEach(card => {
            const live = Number(card.dataset.day) === currentDay &&
                currentMins >= Number(card.dataset.startMins) &&
                currentMins < Number(card.dataset.endMins);
            card.classList.toggle('active-now', live);
            if (live) {
                activeTitle = card.querySelector('.subject-title')?.textContent || '';
                remaining = Number(card.dataset.endMins) - currentMins;
            }
        });

        if (activeTitle) {
            dom.statusBadge.textContent = 'En curso';
            dom.statusText.textContent = `Impartiendo "${activeTitle}" · quedan ${remaining} min`;
        } else if (currentDay < 1 || currentDay > 5) {
            dom.statusBadge.textContent = 'Fin de semana';
            const weekendExtras = store.extrasOn(currentDay);
            dom.statusText.textContent = weekendExtras.length
                ? `${weekendExtras.length} actividad(es) de fin de semana hoy.`
                : 'No hay clases lectivas hoy.';
        } else if (currentMins < timeToMinutes('08:30')) {
            dom.statusBadge.textContent = 'Antes de jornada';
            dom.statusText.textContent = `La jornada comienza en ${timeToMinutes('08:30') - currentMins} min`;
        } else if (currentMins >= timeToMinutes('14:30')) {
            dom.statusBadge.textContent = 'Jornada finalizada';
            dom.statusText.textContent = 'Las clases de hoy han concluido.';
        } else {
            dom.statusBadge.textContent = 'Intervalo';
            dom.statusText.textContent = 'Transición de aula o descanso.';
        }
    }

    /* ============================== Builders del horario ============================== */

    /** Tarjeta de actividad fuera de jornada (horario libre). */
    function buildExtraCard(entry, { showDay = true } = {}) {
        const day = dayDef(entry.day);
        const timeLabel = `${entry.start} - ${entry.end}`;
        const teacher = entry.teacher || store.getTeacher(entry.name);
        const pending = store.pendingTasksFor(entry.name).length;
        const absences = store.getAbsences(entry.name);

        const body = el('div');
        body.appendChild(el('div', { className: 'subject-title', text: entry.name }));
        body.appendChild(el('div', { className: 'subject-teacher', children: [
            svgIcon('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
            document.createTextNode(teacher),
        ] }));
        if (showDay) body.appendChild(el('div', { className: 'subject-day', text: day.name }));

        if (pending > 0 || absences > 0) {
            const badges = el('div', { className: 'card-badges' });
            if (pending > 0) badges.appendChild(el('span', { className: 'badge-indicator task-pending', text: `📝 ${pending}` }));
            if (absences > 0) badges.appendChild(el('span', { className: 'badge-indicator', text: `🚫 ${absences} h` }));
            body.appendChild(badges);
        }

        const card = el('button', {
            className: `class-card extras-card subj-${entry.colorKey}`,
            attrs: {
                type: 'button',
                'aria-label': `${entry.name} (fuera de jornada), con ${teacher}. ${day.name} ${timeLabel}.` +
                    (pending ? ` ${pending} tarea(s) pendiente(s).` : '') +
                    (absences ? ` ${absences} horas de falta.` : ''),
            },
        });
        card.appendChild(body);
        card.appendChild(el('div', { className: 'subject-time', text: timeLabel }));

        card.addEventListener('click', () => openExtraModal({ entry }));
        return card;
    }

    /**
     * Sección "Extraescolares": dinámica y ordenada cronológicamente por día
     * y hora (según las horas personalizadas del usuario). Sin datos → oculta.
     */
    function renderExtrasSection() {
        const frag = document.createDocumentFragment();
        const extras = store.extrasList(); // ya ordenada: día → hora inicio

        let currentDay = null;
        extras.forEach(entry => {
            if (entry.day !== currentDay) {
                currentDay = entry.day;
                frag.appendChild(el('div', {
                    className: 'extras-day-label',
                    text: dayDef(currentDay).name,
                    attrs: { role: 'heading', 'aria-level': '4' },
                }));
            }
            frag.appendChild(buildExtraCard(entry, { showDay: false }));
        });

        dom.extrasSection.hidden = extras.length === 0;
        dom.extrasGrid.replaceChildren(frag);
    }

    function buildBreakCard(day, brk) {
        const timeLabel = `${brk.start} - ${brk.end}`;
        const card = el('button', {
            className: 'class-card break-slot',
            attrs: {
                type: 'button',
                'aria-label': `${brk.name}. ${day.name} ${timeLabel}. Estado: ${cardStatus(day.id, brk.start, brk.end)}.`,
            },
            dataset: {
                day: String(day.id),
                startMins: String(timeToMinutes(brk.start)),
                endMins: String(timeToMinutes(brk.end)),
            },
        });
        card.append(
            el('div', { className: 'subject-title', text: brk.name }),
            el('div', { className: 'subject-time', text: timeLabel }),
        );
        card.addEventListener('click', () => openDetailModal({
            title: brk.name, isBreak: true, dayName: day.name, timeLabel,
            dayId: day.id, startStr: brk.start, endStr: brk.end,
        }));
        return card;
    }

    function buildSubjectCard({ title, colorKey, teacher, day, startStr, endStr }) {
        const timeLabel = `${startStr} - ${endStr}`;
        const pending = store.pendingTasksFor(title).length;
        const absences = store.getAbsences(title);

        const teacherRow = el('div', { className: 'subject-teacher' });
        teacherRow.append(
            svgIcon('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
            document.createTextNode(teacher),
        );

        const body = el('div');
        body.appendChild(el('div', { className: 'subject-title', text: title }));
        body.appendChild(teacherRow);

        if (pending > 0 || absences > 0) {
            const badges = el('div', { className: 'card-badges' });
            if (pending > 0) badges.appendChild(el('span', { className: 'badge-indicator task-pending', text: `📝 ${pending}` }));
            if (absences > 0) badges.appendChild(el('span', { className: 'badge-indicator', text: `🚫 ${absences} h` }));
            body.appendChild(badges);
        }

        const card = el('button', {
            className: `class-card subj-${colorKey}`,
            attrs: {
                type: 'button',
                'aria-label': `${title}, con ${teacher}. ${day.name} ${timeLabel}. Estado: ${cardStatus(day.id, startStr, endStr)}.` +
                    (pending ? ` ${pending} tarea(s) pendiente(s).` : '') +
                    (absences ? ` ${absences} horas de falta.` : ''),
            },
            dataset: {
                day: String(day.id),
                startMins: String(timeToMinutes(startStr)),
                endMins: String(timeToMinutes(endMinsSafe(endStr))),
            },
        });
        card.appendChild(body);
        card.appendChild(el('div', { className: 'subject-time', text: timeLabel }));

        card.addEventListener('click', () => openDetailModal({
            title, isBreak: false, teacher, dayName: day.name, timeLabel,
            dayId: day.id, startStr, endStr,
        }));
        return card;
    }

    const endMinsSafe = (endStr) => endStr; // claridad de lectura en dataset

    /** Tarjetas de un par de franjas contiguas (fusionadas si son la misma materia). */
    function buildCardsForPair(day, slotA, slotB, { rows = null } = {}) {
        const sA = SLOTS.find(s => s.num === slotA);
        const sB = SLOTS.find(s => s.num === slotB);
        const eA = store.schedule[`${day.id}-${slotA}`];
        const eB = store.schedule[`${day.id}-${slotB}`];

        if (eA && eB && eA.name === eB.name) {
            const card = buildSubjectCard({
                title: eA.name, colorKey: eA.colorKey, teacher: store.getTeacher(eA.name),
                day, startStr: sA.start, endStr: sB.end,
            });
            if (rows) card.style.gridRow = `${rows[0]} / ${rows[1] + 1}`; // fusiona ambas filas
            return [card];
        }

        const cards = [];
        [[eA, sA, rows?.[0]], [eB, sB, rows?.[1]]].forEach(([entry, slotDef, row]) => {
            if (!entry) return;
            const card = buildSubjectCard({
                title: entry.name, colorKey: entry.colorKey, teacher: store.getTeacher(entry.name),
                day, startStr: slotDef.start, endStr: slotDef.end,
            });
            if (row) card.style.gridRow = String(row);
            cards.push(card);
        });
        return cards;
    }

    function buildMobileDayBlock(day, { includeLective = true } = {}) {
        const list = el('div', { className: 'mobile-day-list' });

        if (includeLective) {
            SCHEDULE_BLOCKS.forEach(block => {
                buildCardsForPair(day, block.slots[0], block.slots[1]).forEach(c => list.appendChild(c));
                const brk = BREAKS.find(br => br.row === block.row1 + 2);
                if (brk) list.appendChild(buildBreakCard(day, brk));
            });
        }

        // Actividades fuera de jornada de ese día (horario libre, ya ordenadas)
        store.extrasOn(day.id).forEach(entry => list.appendChild(buildExtraCard(entry, { showDay: false })));

        const isOpen = ui.expandedMobileDays.has(day.id);
        const headerBtn = el('button', {
            className: 'mobile-day-header',
            attrs: { type: 'button', 'aria-expanded': String(isOpen) },
        });
        headerBtn.append(
            el('span', { text: day.name }),
            el('span', { className: 'chevron', attrs: { 'aria-hidden': 'true' }, text: '▾' }),
        );

        const block = el('div', { className: `mobile-day-block${isOpen ? ' open' : ''}` });
        headerBtn.addEventListener('click', () => {
            const open = block.classList.toggle('open');
            headerBtn.setAttribute('aria-expanded', String(open));
            if (open) ui.expandedMobileDays.add(day.id);
            else ui.expandedMobileDays.delete(day.id);
        });

        block.append(headerBtn, list);
        return block;
    }

    /* ============================== Render: Horario ============================== */

    /**
     * Días visibles según el modo:
     *  - "Semana": L-V siempre (jornada lectiva) + Sábado/Domingo SOLO si tienen
     *    actividades agendadas fuera de jornada.
     *  - "Hoy": día seleccionado (incluye sáb/dom si tienen actividades).
     */
    function visibleDaysFor(mode) {
        if (mode === 'weekly') {
            return [...DAYS.filter(d => !d.weekend),
                    ...DAYS.filter(d => d.weekend && store.extrasOn(d.id).length > 0)];
        }
        const selected = dayDef(ui.selectedDayIndex);
        if (!selected.weekend || store.extrasOn(selected.id).length > 0) return [selected];
        // Día de fin de semana sin actividades → sin columnas (se avisa en la UI)
        return [];
    }

    function renderSchedule() {
        const frag = document.createDocumentFragment();
        const todayId = new Date().getDay();
        const visibleDays = visibleDaysFor(ui.viewMode);

        // Vista diaria en fin de semana sin actividades: estado vacío claro
        if (!visibleDays.length) {
            const empty = el('div', {
                className: 'schedule-empty',
                attrs: { role: 'status' },
                text: `${dayDef(ui.selectedDayIndex).name} sin actividades agendadas. Usa "Nueva asignatura" para añadir una a cualquier hora.`,
            });
            frag.appendChild(empty);
            dom.wrapper.replaceChildren(frag);
            renderExtrasSection();
            updateLiveTracker(true);
            return;
        }

        // Escritorio: parrilla CSS Grid (con fusiones de franjas contiguas)
        const grid = el('div', { className: 'schedule-grid' });
        grid.style.gridTemplateColumns = `85px repeat(${visibleDays.length}, 1fr)`;

        // Cabeceras y horas con posición explícita (el auto-placement rompería la parrilla)
        const horaHead = el('div', { className: 'grid-header', text: 'Hora' });
        horaHead.style.gridRow = '1';
        horaHead.style.gridColumn = '1';
        grid.appendChild(horaHead);

        visibleDays.forEach((day, idx) => {
            const head = el('div', {
                className: `grid-header${day.id === todayId ? ' current-day-col' : ''}`,
                text: day.name,
            });
            head.style.gridRow = '1';
            head.style.gridColumn = String(idx + 2);
            grid.appendChild(head);
        });

        GRID_ROWS.forEach(({ row, label }) => {
            const slot = el('div', { className: 'time-slot', text: label });
            slot.style.gridRow = String(row);
            slot.style.gridColumn = '1';
            grid.appendChild(slot);
        });

        visibleDays.forEach((day, dayIdx) => {
            const colIndex = dayIdx + 2;
            // Los fines de semana no tienen jornada lectiva: solo actividades libres
            if (!day.weekend) {
                SCHEDULE_BLOCKS.forEach(block => {
                    buildCardsForPair(day, block.slots[0], block.slots[1], { rows: [block.row1, block.row2] })
                        .forEach(card => {
                            card.style.gridColumn = String(colIndex);
                            grid.appendChild(card);
                        });
                    const brk = BREAKS.find(br => br.row === block.row1 + 2);
                    if (brk) {
                        const brkCard = buildBreakCard(day, brk);
                        brkCard.style.gridColumn = String(colIndex);
                        brkCard.style.gridRow = String(brk.row);
                        grid.appendChild(brkCard);
                    }
                });
            }
        });

        // Móvil: acordeón de tarjetas por día (CSS decide cuál mostrar)
        const mobile = el('div', { className: 'schedule-mobile' });
        visibleDays.forEach(day =>
            mobile.appendChild(buildMobileDayBlock(day, { includeLective: !day.weekend })));

        frag.append(grid, mobile);
        dom.wrapper.replaceChildren(frag); // una sola mutación del DOM
        renderExtrasSection();
        updateLiveTracker(true);
    }

    /* ============================== Render: Calendario ============================== */

    function renderCalendar() {
        const frag = document.createDocumentFragment();
        const year = ui.currentCalDate.getFullYear();
        const month = ui.currentCalDate.getMonth();
        dom.calendarMonthYear.textContent =
            new Date(year, month).toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });

        const startingDay = (new Date(year, month, 1).getDay() + 6) % 7; // lunes = 0
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const prevMonthDays = new Date(year, month, 0).getDate();
        const todayStr = getLocalDateString();

        const buildCell = ({ label, dateStr, otherMonth }) => {
            const cell = el('button', {
                className: 'calendar-day-cell' + (otherMonth ? ' other-month' : ''),
                attrs: { type: 'button' },
            });
            if (dateStr === todayStr) cell.classList.add('today-cell');
            if (dateStr === ui.selectedCalDayStr) cell.classList.add('selected-cell');

            cell.appendChild(el('span', { className: 'day-number', text: label }));

            if (otherMonth) {
                cell.disabled = true; // no foco, no clic: ruido de tabulación eliminado
                return cell;
            }

            const tasks = store.tasksOn(dateStr);
            cell.setAttribute('aria-label',
                `${new Date(year, month, Number(label)).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })}` +
                (tasks.length ? `. ${tasks.length} evento(s) agendado(s).` : '. Sin eventos.'));
            if (dateStr === todayStr) cell.setAttribute('aria-current', 'date');

            if (tasks.length) {
                const chips = el('div', { className: 'day-events-list' });
                tasks.slice(0, 3).forEach(t => {
                    chips.appendChild(el('span', {
                        className: `event-dot-chip ${t.type}`,
                        text: `${t.type}: ${t.subject}`,
                        attrs: { title: `${t.type}: ${t.subject} — ${t.text}` },
                    }));
                });
                cell.appendChild(chips);
                cell.appendChild(el('span', { className: 'event-count-pill', text: String(tasks.length) }));
            }

            cell.addEventListener('click', () => {
                ui.selectedCalDayStr = dateStr;
                renderCalendar();
            });
            return cell;
        };

        for (let i = startingDay - 1; i >= 0; i--) {
            frag.appendChild(buildCell({ label: String(prevMonthDays - i), dateStr: null, otherMonth: true }));
        }
        for (let d = 1; d <= daysInMonth; d++) {
            frag.appendChild(buildCell({ label: String(d), dateStr: getLocalDateString(new Date(year, month, d)), otherMonth: false }));
        }
        const trailing = (startingDay + daysInMonth) % 7;
        for (let i = 1; i <= (7 - trailing) % 7; i++) {
            frag.appendChild(buildCell({ label: String(i), dateStr: null, otherMonth: true }));
        }

        dom.calendarDatesGrid.replaceChildren(frag);
        renderCalendarDetails();
    }

    function renderCalendarDetails() {
        const tasks = store.tasksOn(ui.selectedCalDayStr);
        const [y, m, d] = ui.selectedCalDayStr.split('-').map(Number);
        const nice = new Date(y, m - 1, d).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        dom.selectedDayTitle.textContent = `Eventos para el ${nice}`;
        dom.calendarTasksContainer.replaceChildren();

        if (!tasks.length) {
            dom.calendarTasksContainer.appendChild(
                el('p', { className: 'absence-hint', text: 'Sin exámenes o entregas agendadas para esta fecha.' }),
            );
            return;
        }

        const frag = document.createDocumentFragment();
        tasks.forEach(task => {
            const left = el('div', { className: 'task-left' });
            left.appendChild(el('span', { className: `task-tag ${task.type}`, text: task.type }));
            const label = el('span');
            label.appendChild(el('strong', { text: `[${task.subject}] ` }));
            label.appendChild(document.createTextNode(`${task.text} (${task.date})`));
            left.appendChild(label);

            frag.appendChild(el('div', {
                className: `task-item ${task.done ? 'completed' : ''}`,
                children: [left, el('span', { text: task.done ? '✔ Completada' : '⏳ Pendiente' })],
            }));
        });
        dom.calendarTasksContainer.replaceChildren(frag);
    }

    /* ============================== Render: Directorio y Recursos ============================== */

    function renderDirectory() {
        const query = normalize(dom.directorySearch.value || '').trim();

        const teacherMap = new Map();
        store.subjects().forEach((teacher, subject) => {
            const list = teacherMap.get(teacher) || [];
            list.push(subject);
            teacherMap.set(teacher, list);
        });

        const emptyMsg = () => el('p', { className: 'absence-hint', text: 'Sin resultados para la búsqueda.' });

        // Índice por profesores
        const teachersFrag = document.createDocumentFragment();
        let teachersShown = 0;
        teacherMap.forEach((subjects, teacher) => {
            const match = !query || normalize(teacher).includes(query) || subjects.some(s => normalize(s).includes(query));
            if (!match) return;
            teachersShown++;

            const body = el('div');
            subjects.forEach(subj => {
                const occ = store.slotsOf(subj).map(s => `${s.dayName} (${s.time})`);
                body.appendChild(el('div', {
                    className: 'index-subitem',
                    children: [el('strong', { text: subj }), el('span', { text: occ.join(', ') || 'Sin sesiones' })],
                }));
            });
            teachersFrag.appendChild(el('div', {
                className: 'index-card',
                children: [
                    el('div', {
                        className: 'index-card-title',
                        children: [
                            svgIcon('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
                            el('span', { text: teacher }),
                        ],
                    }),
                    body,
                ],
            }));
        });
        if (!teachersShown) teachersFrag.appendChild(emptyMsg());
        dom.teachersIndexList.replaceChildren(teachersFrag);

        // Índice por asignaturas
        const subjectsFrag = document.createDocumentFragment();
        let subjectsShown = 0;
        store.subjects().forEach((teacher, subject) => {
            const match = !query || normalize(subject).includes(query) || normalize(teacher).includes(query);
            if (!match) return;
            subjectsShown++;

            const occ = store.slotsOf(subject).map(s => `${s.dayName} (${s.time})`);
            subjectsFrag.appendChild(el('div', {
                className: 'index-card',
                children: [
                    el('div', {
                        className: 'index-card-title',
                        children: [
                            svgIcon('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>'),
                            el('span', { text: subject }),
                        ],
                    }),
                    el('div', { className: 'index-subitem', children: [el('span', { text: 'Profesor/a: ' }), el('strong', { text: teacher })] }),
                    el('div', { className: 'index-subitem', children: [el('span', { text: 'Sesiones: ' }), el('span', { text: occ.join(' | ') || 'Sin sesiones' })] }),
                ],
            }));
        });
        if (!subjectsShown) subjectsFrag.appendChild(emptyMsg());
        dom.subjectsIndexList.replaceChildren(subjectsFrag);
    }

    function renderGeneralResources() {
        const query = normalize(dom.resourcesSearch.value || '').trim();
        const frag = document.createDocumentFragment();
        let shown = 0;

        GENERAL_RESOURCES.forEach(res => {
            if (query && !normalize(res.title).includes(query) && !normalize(res.description).includes(query)) return;
            shown++;

            const link = el('a', {
                className: 'btn-open-link',
                attrs: { href: res.url, target: '_blank', rel: 'noopener noreferrer' },
                text: 'Abrir recurso',
            });
            link.appendChild(svgIcon('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>'));
            frag.appendChild(el('div', {
                className: 'resource-card',
                children: [
                    el('div', { children: [el('h3', { text: res.title }), el('p', { text: res.description })] }),
                    link,
                ],
            }));
        });
        if (!shown) frag.appendChild(el('p', { className: 'absence-hint', text: 'Sin resultados para la búsqueda.' }));
        dom.generalResourcesGrid.replaceChildren(frag);
    }

    /* ============================== Modal de detalle ============================== */

    function openDetailModal({ title, isBreak, teacher, dayName, timeLabel, dayId, startStr, endStr }) {
        ui.currentActiveSubject = isBreak ? null : title;
        ui.activeSlot = isBreak ? null : {
            dayId,
            slotNum: SLOTS.find(s => s.start === startStr)?.num || 1,
        };
        ui.activeExtra = null;

        dom.modalTitle.textContent = title;
        dom.modalTime.textContent = `${dayName} · ${timeLabel}`;
        dom.modalStatus.textContent = cardStatus(dayId, startStr, endStr);

        if (isBreak) {
            dom.modalTag.textContent = 'Intervalo / Descanso';
            dom.modalTabHeaders.style.display = 'none';
            dom.rowTeacher.style.display = 'none';
            dom.modalResourcesRow.style.display = 'none';
            dom.btnEditSubject.style.display = 'none';
        } else {
            dom.modalTag.textContent = 'Asignatura lectiva';
            dom.modalTabHeaders.style.display = 'flex';
            dom.rowTeacher.style.display = 'flex';
            dom.modalResourcesRow.style.display = 'flex';
            dom.btnEditSubject.style.display = 'inline-flex';
            const teacher = store.getTeacher(title);
            dom.modalTeacher.textContent = teacher;
            renderModalResources(teacher);   // ← filtrado estricto por docente
            renderTaskList();
            renderGradesList();
            updateAbsenceDisplay();
        }
        selectModalTab('info');

        openOverlay(dom.modal);
    }

    /**
     * Regla estricta: pinta SOLO los recursos que corresponden al docente
     * (Marisol → Google Classroom; resto → Aula Virtual Moodle).
     */
    function renderModalResources(teacherName) {
        const frag = document.createDocumentFragment();
        resourcesForTeacher(teacherName).forEach(res => {
            frag.appendChild(el('a', {
                className: 'res-link',
                attrs: { href: res.url, target: '_blank', rel: 'noopener noreferrer' },
                text: res.title,
            }));
        });
        dom.modalResourcesList.replaceChildren(frag);
    }

    function renderTaskList() {
        if (!ui.currentActiveSubject) return;
        const tasks = store.tasksFor(ui.currentActiveSubject);
        dom.tabTaskCount.textContent = String(tasks.filter(t => !t.done).length);

        const frag = document.createDocumentFragment();
        if (!tasks.length) {
            frag.appendChild(el('p', { className: 'absence-hint', text: 'No hay tareas o exámenes registrados para este módulo.' }));
        }

        tasks.forEach(task => {
            const checkbox = el('input', {
                attrs: { type: 'checkbox', 'data-task-id': String(task.id) },
            });
            checkbox.checked = task.done;
            checkbox.addEventListener('change', (e) => {
                store.setTaskDone(task.id, e.target.checked);
                // store:change reconstruye la lista: devolvemos el foco al mismo checkbox
                const cb = dom.taskList.querySelector(`input[data-task-id="${task.id}"]`);
                if (cb) cb.focus();
            });
            const delBtn = el('button', {
                className: 'btn-del-task',
                attrs: { type: 'button', 'aria-label': `Eliminar tarea: ${task.text}` },
                text: '×',
            });
            delBtn.addEventListener('click', () => {
                store.removeTask(task.id);
                const next = dom.taskList.querySelector('input[type="checkbox"], .btn-del-task');
                (next || dom.taskInput).focus();
            });

            const label = el('span');
            label.appendChild(el('span', { text: `${task.text} ` }));
            if (task.date) label.appendChild(el('small', { text: `(${task.date})` }));

            frag.appendChild(el('div', {
                className: `task-item ${task.done ? 'completed' : ''}`,
                children: [
                    el('div', {
                        className: 'task-left',
                        children: [checkbox, el('span', { className: `task-tag ${task.type}`, text: task.type }), label],
                    }),
                    delBtn,
                ],
            }));
        });

        dom.taskList.replaceChildren(frag);
    }

    /* ============================== Modal: fuera de jornada ============================== */

    /** Detalle de una actividad fuera de jornada: tareas/faltas compartidas por nombre. */
    function openExtraModal({ entry }) {
        ui.currentActiveSubject = entry.name;
        ui.activeSlot = null;
        ui.activeExtra = { day: entry.day, start: entry.start };

        const day = dayDef(entry.day);
        const timeLabel = `${entry.start} - ${entry.end}`;
        dom.modalTitle.textContent = entry.name;
        dom.modalTime.textContent = `${day.name} · ${timeLabel}`;
        dom.modalStatus.textContent = cardStatus(entry.day, entry.start, entry.end);
        dom.modalTag.textContent = 'Fuera de jornada';
        dom.modalTabHeaders.style.display = 'flex';
        dom.rowTeacher.style.display = 'flex';
        dom.modalResourcesRow.style.display = 'flex';
        dom.btnEditSubject.style.display = 'inline-flex';
        dom.modalTeacher.textContent = entry.teacher || store.getTeacher(entry.name);
        renderModalResources(dom.modalTeacher.textContent); // misma regla estricta de recursos
        renderTaskList();
        renderGradesList();
        updateAbsenceDisplay();
        selectModalTab('info');

        openOverlay(dom.modal);
    }

    /* ============================== Calculadora de notas ============================== */

    function renderGradesList() {
        if (!ui.currentActiveSubject) return;
        const list = store.gradesFor(ui.currentActiveSubject);
        const stats = store.gradeStats(ui.currentActiveSubject);

        const frag = document.createDocumentFragment();
        if (!list.length) {
            frag.appendChild(el('p', { className: 'absence-hint', text: 'No hay exámenes registrados para este módulo.' }));
        }

        list.forEach(g => {
            const delBtn = el('button', {
                className: 'btn-del-task',
                attrs: { type: 'button', 'aria-label': `Eliminar nota: ${g.name}` },
                text: '×',
            });
            delBtn.addEventListener('click', () => {
                store.removeGrade(g.id);
            });

            const label = el('span');
            label.appendChild(el('strong', { text: `${g.name}: ` }));
            label.appendChild(document.createTextNode(`${g.value.toFixed(1)} / 10`));

            frag.appendChild(el('div', {
                className: 'task-item',
                children: [label, delBtn],
            }));
        });

        dom.gradeList.replaceChildren(frag);

        if (stats.average === null) {
            dom.gradeAverageDisplay.textContent = '-- / 10';
            dom.gradeNeededDisplay.textContent = 'Añade notas de exámenes para calcular la media.';
        } else {
            dom.gradeAverageDisplay.textContent = `${stats.average.toFixed(2)} / 10`;
            dom.gradeNeededDisplay.textContent = 'ℹ️ Nota no definitiva: esta media corresponde únicamente a los exámenes. Falta añadir la calificación de las tareas/trabajos y comportamiento (20-30% restante).';
        }
    }

    dom.gradeForm.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!ui.currentActiveSubject) return;
        const name = dom.gradeName.value.trim();
        const value = parseFloat(dom.gradeValue.value);

        if (!name || isNaN(value)) return;

        // addGrade es asíncrono: en modo invitado detiene la acción y lanza el login
        store.addGrade({ subject: ui.currentActiveSubject, name, value });

        dom.gradeName.value = '';
        dom.gradeValue.value = '';
        dom.gradeName.focus();
    });

    /* ============================== Faltas + barra de progreso ============================== */

    function updateAbsenceDisplay() {
        if (!ui.currentActiveSubject) return;
        const count = store.getAbsences(ui.currentActiveSubject);
        const stats = store.absenceStats(ui.currentActiveSubject);
        const limit = stats.limit;
        const pct = limit > 0 ? clamp(Math.round((count / limit) * 100), 0, 100) : (count > 0 ? 100 : 0);

        dom.absenceCountDisplay.textContent = String(count);
        dom.absenceProgressFill.style.width = `${pct}%`;
        dom.absenceProgress.setAttribute('aria-valuenow', String(count));
        dom.absenceProgress.setAttribute('aria-valuemax', String(limit));
        dom.absenceProgress.setAttribute('aria-valuetext', `${count} horas de ${limit} permitidas`);
        dom.absenceProgress.classList.toggle('warn', pct >= 66 && pct < 100);
        dom.absenceProgress.classList.toggle('danger', pct >= 100);

        // Formato exigido: "[Faltas actuales] h / [Límite máximo del trimestre] h permitidas"
        dom.absenceProgressLabel.textContent = count > limit
            ? `⚠️ ${count} h / ${limit} h permitidas: pérdida de evaluación continua`
            : `${count} h / ${limit} h permitidas (${pct} %)`;

        // Desglose transparente del cálculo real (a + b + c)
        dom.absenceTrimesterInfo.textContent =
            `${TERM_1.label} · ${stats.weekly} h/sem × ${stats.weeks} sem − ${stats.holidayHours} h festivos = ${stats.total} h reales · 15 % = ${limit} h`;
    }

    dom.btnAddAbsence.addEventListener('click', () => {
        if (!ui.currentActiveSubject) return;
        store.setAbsences(ui.currentActiveSubject, store.getAbsences(ui.currentActiveSubject) + 1);
    });

    dom.btnSubAbsence.addEventListener('click', () => {
        if (!ui.currentActiveSubject) return;
        store.setAbsences(ui.currentActiveSubject, store.getAbsences(ui.currentActiveSubject) - 1);
    });

    /* ============================== Editor de asignaturas ==============================
     * Dos modos:
     *  - Lectivo: edición de las 6 franjas fijas de la jornada (L-V 08:30-14:30).
     *  - Libre:   alta/edición FUERA de jornada con <input type="time"> a gusto
     *    del usuario. En sáb/dom no hay restricción horaria; de L-V la actividad
     *    libre no puede invadir la jornada presencial.
     * El botón "Nueva asignatura" abre SIEMPRE el modo libre → una creación
     * nueva jamás ocupa una franja lectiva.
     */

    /** Rellena selects del editor y aplica el modo (franja fija vs horas libres). */
    function populateEditorSelects(mode) {
        dom.subjectDay.replaceChildren(
            ...DAYS.map(d => {
                const opt = el('option', { text: d.weekend ? `${d.name} (fin de semana)` : d.name });
                opt.value = String(d.id);
                return opt;
            }),
        );
        dom.subjectColor.replaceChildren(
            ...COLOR_KEYS.map(k => {
                const opt = el('option', { text: COLOR_LABELS[k] });
                opt.value = k;
                return opt;
            }),
        );
        const datalist = $('#teachers-datalist');
        if (datalist) {
            datalist.replaceChildren(
                ...[...new Set(Object.values(store.teachers))].sort((a, b) => a.localeCompare(b, 'es'))
                    .map(t => el('option', { attrs: { value: t } })),
            );
        }
        applyEditorMode(mode);
    }

    /** Franja fija (lectivo) vs campos <input type="time"> (horario flexible). */
    function applyEditorMode(mode) {
        const isExtra = mode === 'extra';
        dom.subjectSlotField.hidden = isExtra;
        dom.subjectTimes.hidden = !isExtra;
        dom.subjectSlotLabel.textContent = isExtra ? 'Horario personalizado' : 'Franja horaria';
    }

    function openEditor({ mode = 'extra', dayId, slotNum, day, start } = {}) {
        const isExtra = mode === 'extra';
        populateEditorSelects(isExtra ? 'extra' : 'normal');
        ui.editingKey = null;
        ui.editingExtra = null;
        ui.pendingExtraTarget = null;
        dom.editorError.hidden = true;

        if (isExtra) {
            if (day !== undefined && start) {
                // Editar actividad existente fuera de jornada
                const entry = store.extracurricular[`${day}|${start}`];
                if (!entry) return;
                ui.editingExtra = { day, start };
                dom.editorTag.textContent = 'Editar actividad';
                dom.editorTitle.textContent = `${dayDef(day).name} · ${entry.start} - ${entry.end}`;
                dom.subjectName.value = entry.name;
                dom.subjectTeacher.value = entry.teacher || '';
                dom.subjectDay.value = String(day);
                dom.subjectStart.value = entry.start;
                dom.subjectEnd.value = entry.end;
                dom.subjectColor.value = entry.colorKey;
                dom.btnDeleteSlot.hidden = false;
            } else {
                // Alta nueva: día y horas totalmente libres (sáb/dom sin restricción)
                dom.editorTag.textContent = 'Nueva actividad (horario flexible)';
                dom.editorTitle.textContent = 'Nueva actividad fuera de jornada';
                dom.editorForm.reset();
                applyEditorMode('extra');
                dom.subjectDay.value = String(ui.selectedDayIndex);
                dom.subjectStart.value = '16:00';
                dom.subjectEnd.value = '17:15';
                dom.subjectColor.value = 'montaje';
                dom.btnDeleteSlot.hidden = true;
            }
        } else {
            // Modo lectivo: solo accesible desde "Editar" en el modal de detalle
            applyEditorMode('normal');
            const entry = store.schedule[`${dayId}-${slotNum}`];
            if (!entry) return;
            ui.editingKey = `${dayId}-${slotNum}`;
            const d = dayDef(dayId);
            const slotDef = SLOTS.find(s => s.num === slotNum);
            dom.editorTag.textContent = 'Editar franja lectiva';
            dom.editorTitle.textContent = `${d.name} · ${slotDef.start} - ${slotDef.end}`;
            dom.subjectName.value = entry.name;
            const t = store.getTeacher(entry.name);
            dom.subjectTeacher.value = t === 'Sin asignar' ? '' : t;
            dom.subjectDay.value = String(dayId);
            dom.subjectSlot.value = String(slotNum);
            dom.subjectColor.value = entry.colorKey;
            dom.btnDeleteSlot.hidden = false;
        }

        openOverlay(dom.editorModal);
        dom.subjectName.focus({ preventScroll: true });
    }

    function closeEditor() {
        if (!dom.editorModal.classList.contains('active')) return;
        closeOverlay(dom.editorModal);
        ui.editingKey = null;
        ui.editingExtra = null;
        ui.pendingExtraTarget = null;
    }

    const showEditorError = (msg) => {
        dom.editorError.textContent = msg;
        dom.editorError.hidden = false;
    };

    /** ¿[ini,fin) solapa con la jornada lectiva L-V 08:30-14:30? */
    const hitsJornada = (day, start, end) =>
        day >= 1 && day <= 5 &&
        timeToMinutes(start) < JORNADA.endMins &&
        timeToMinutes(end) > JORNADA.startMins;

    /** ¿[ini,fin) solapa con otra actividad libre del mismo día? */
    const hitsOtherExtra = (day, start, end, ignoreStart) =>
        store.extrasOn(day).some(x =>
            x.start !== ignoreStart &&
            timeToMinutes(start) < timeToMinutes(x.end) &&
            timeToMinutes(end) > timeToMinutes(x.start));

    dom.editorForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = dom.subjectName.value.trim();
        const teacher = dom.subjectTeacher.value.trim();
        const colorKey = dom.subjectColor.value;

        if (!name) {
            showEditorError('El nombre de la asignatura es obligatorio.');
            dom.subjectName.focus();
            return;
        }

        const isExtraMode = !dom.subjectTimes.hidden;

        // -------- MODO LIBRE (fuera de jornada, con <input type="time">) --------
        if (isExtraMode) {
            const day = Number(dom.subjectDay.value);
            const start = dom.subjectStart.value;
            const end = dom.subjectEnd.value;
            const isWeekend = dayDef(day)?.weekend;

            if (!start || !end) {
                showEditorError('Indica la hora de inicio y la de fin de la actividad.');
                return;
            }
            if (timeToMinutes(start) >= timeToMinutes(end)) {
                showEditorError('La hora de fin debe ser posterior a la de inicio.');
                dom.subjectEnd.focus();
                return;
            }
            if (!isWeekend && hitsJornada(day, start, end)) {
                showEditorError(`De lunes a viernes la actividad no puede invadir la jornada lectiva (08:30-14:30). Usa una franja lectiva o cambia la hora.`);
                dom.subjectStart.focus();
                return;
            }
            if (hitsOtherExtra(day, start, end, ui.editingExtra?.start)) {
                const other = store.extrasOn(day).find(x => x.start !== ui.editingExtra?.start &&
                    timeToMinutes(start) < timeToMinutes(x.end) && timeToMinutes(end) > timeToMinutes(x.start));
                showEditorError(`Solapa con "${other.name}" (${other.start} - ${other.end}) del ${dayDef(day).name}.`);
                return;
            }

            if (ui.editingExtra) {
                const oldEntry = store.extracurricular[`${ui.editingExtra.day}|${ui.editingExtra.start}`];
                const moved = ui.editingExtra.day !== day || ui.editingExtra.start !== start;
                if (oldEntry && oldEntry.name !== name) {
                    await store.renameSubject(oldEntry.name, name, teacher);
                }
                if (moved) await store.removeExtra(ui.editingExtra.day, ui.editingExtra.start); // libera el origen
            }
            store.setExtra({ day, start, end, name, teacher, colorKey });
            closeEditor();
            return;
        }

        // -------- MODO LECTIVO (solo edición de franjas existentes 1-6, L-V) --------
        const day = Number(dom.subjectDay.value);
        if (dayDef(day)?.weekend) {
            showEditorError('Las franjas lectivas fijas solo existen de lunes a viernes.');
            return;
        }
        const slot = Number(dom.subjectSlot.value);
        const targetKey = `${day}-${slot}`;
        if (store.schedule[targetKey] && ui.editingKey !== targetKey) {
            const occupied = store.schedule[targetKey].name;
            const slotDef = SLOTS.find(s => s.num === slot);
            showEditorError(`La franja del ${dayDef(day).name} (${slotDef.start} - ${slotDef.end}) ya está ocupada por "${occupied}".`);
            return;
        }

        if (ui.editingKey) {
            const [oldDay, oldSlot] = ui.editingKey.split('-').map(Number);
            const oldEntry = store.schedule[ui.editingKey];
            const moved = oldDay !== day || oldSlot !== slot;

            if (oldEntry && oldEntry.name !== name) {
                await store.renameSubject(oldEntry.name, name, teacher); // renombra todas las franjas
            }
            if (moved) {
                await store.setSlot(oldDay, oldSlot, null);              // libera el origen
            }
            store.setSlot(day, slot, { name, colorKey, teacher });
        } else {
            store.setSlot(day, slot, { name, colorKey, teacher });
        }

        closeEditor();
    });

    dom.btnDeleteSlot.addEventListener('click', () => {
        if (ui.editingExtra) {
            store.removeExtra(ui.editingExtra.day, ui.editingExtra.start);
        } else if (ui.editingKey) {
            const [day, slot] = ui.editingKey.split('-').map(Number);
            store.setSlot(day, slot, null);
        }
        closeEditor();
    });

    dom.btnEditorCancel.addEventListener('click', closeEditor);
    dom.editorClose.addEventListener('click', closeEditor);
    dom.editorModal.addEventListener('click', (e) => {
        if (e.target === dom.editorModal) closeEditor();
    });

    /* ============================== Autenticación: UI (header) ============================== */

    const GOOGLE_G_SVG = '<svg class="google-g" viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.28-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>';

    const userInitials = (user) => {
        const base = String(user.displayName || user.email || '?').trim();
        const parts = base.split(/\s+/);
        return (parts.length >= 2 ? parts[0][0] + parts[parts.length - 1][0] : base.slice(0, 2)).toUpperCase();
    };

    /** Pinta el área de autenticación del header según la sesión actual. */
    function renderAuthUI() {
        if (!dom.authArea) return;
        const user = (CloudSvc.ready && CloudSvc.auth) ? CloudSvc.auth.currentUser : null;
        if (user) {
            dom.authArea.classList.add('is-auth');
            dom.btnLoginGoogle.hidden = true;
            dom.userChip.hidden = false;
            if (user.photoURL) {
                dom.userAvatar.src = user.photoURL;
                dom.userAvatar.hidden = false;
                dom.userFallback.hidden = true;
            } else {
                dom.userAvatar.removeAttribute('src');
                dom.userAvatar.hidden = true;
                dom.userFallback.hidden = false;
                dom.userFallback.textContent = userInitials(user);
            }
            dom.userName.textContent = user.displayName || 'Usuario';
            dom.userEmail.textContent = user.email || '';
        } else {
            dom.authArea.classList.remove('is-auth');
            dom.btnLoginGoogle.hidden = false;
            dom.userChip.hidden = true;
        }
    }

    let authToastTimer = null;
    function showAuthToast(message) {
        if (!dom.authToast) return;
        dom.authToast.textContent = message;
        dom.authToast.hidden = false;
        dom.authToast.classList.add('visible');
        clearTimeout(authToastTimer);
        authToastTimer = setTimeout(() => {
            dom.authToast.classList.remove('visible');
            dom.authToast.hidden = true;
        }, 4000);
    }

    if (dom.btnLoginGoogle) {
        dom.btnLoginGoogle.addEventListener('click', async () => {
            dom.btnLoginGoogle.disabled = true;
            try {
                const user = await CloudSvc.signIn();
                if (user) await AuthSync.sync(user, { force: true });
            } catch (err) {
                if (!(err && (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request'))) {
                    console.error('Auth: no se pudo iniciar sesión.', err);
                    showAuthToast('No se pudo iniciar sesión con Google. Inténtalo de nuevo.');
                }
            } finally {
                dom.btnLoginGoogle.disabled = false;
            }
        });
    }

    if (dom.btnLogout) {
        dom.btnLogout.addEventListener('click', () => AuthSync.unsync());
    }

    // Última sincronización al cerrar/ocultar la pestaña (por si queda algo en vuelo)
    window.addEventListener('pagehide', () => { if (store.isSynced) store.pushRemote(); });

    /* ============================== Export / Import / Reset ============================== */

    function exportData() {
        try {
            const blob = new Blob([JSON.stringify(store.toJSON(), null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = el('a', { attrs: { href: url, download: `horario-academico-${getLocalDateString()}.json` } });
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (err) {
            console.error('Export: fallo al generar el archivo.', err);
            window.alert('No se pudo generar el archivo de respaldo.');
        }
        
    }

    function exportToICS() {
        const tasks = store.tasks;
        if (!tasks.length) {
            window.alert('No hay tareas o exámenes agendados para exportar.');
            return;
        }

        let icsContent = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//Horario 2SMR//ES',
            'CALSCALE:GREGORIAN'
        ];

        tasks.forEach(t => {
            const dateStr = t.date.replace(/-/g, '');
            icsContent.push(
                'BEGIN:VEVENT',
                `SUMMARY:[${t.type}] ${t.subject} - ${t.text}`,
                `DTSTART;VALUE=DATE:${dateStr}`,
                `DTEND;VALUE=DATE:${dateStr}`,
                `DESCRIPTION:Asignatura: ${t.subject} \\nTipo: ${t.type}`,
                'END:VEVENT'
            );
        });

        icsContent.push('END:VCALENDAR');

        try {
            const blob = new Blob([icsContent.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = el('a', { attrs: { href: url, download: `examenes-2smr-${getLocalDateString()}.ics` } });
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (err) {
            console.error('ICS Export: fallo al generar el archivo.', err);
            window.alert('No se pudo generar el archivo .ics.');
        }
    }

    function importData(file) {
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const data = JSON.parse(reader.result);
                if (!isObject(data)) throw new Error('el archivo no contiene un objeto JSON');
                if (!window.confirm('Esto reemplazará horario, profesores, tareas y faltas actuales por los del archivo. ¿Continuar?')) return;
                store.replaceAll(data).then(ok => {
                    if (ok) window.alert('Datos importados correctamente.');
                    // Si ok === false el flujo de login con Google ya está en marcha
                });
            } catch (err) {
                console.error('Import: archivo inválido.', err);
                window.alert(`No se pudo importar el archivo: ${err.message}`);
            }
        };
        reader.onerror = () => window.alert('No se pudo leer el archivo seleccionado.');
        reader.readAsText(file);
    }

    dom.btnExport.addEventListener('click', exportData);
    dom.btnExportIcs.addEventListener('click', exportToICS);
    dom.btnImport.addEventListener('click', () => dom.importFile.click());
    dom.importFile.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (file) importData(file);
        e.target.value = ''; // permite reimportar el mismo archivo
    });

    dom.btnReset.addEventListener('click', () => {
        if (window.confirm('Se restaurará el horario original y se borrarán tareas, faltas y cambios guardados. ¿Continuar?')) {
            store.resetAll();
        }
    });

    /* ============================== Tareas: formulario ============================== */

    dom.taskForm.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!ui.currentActiveSubject) return;
        const text = dom.taskInput.value.trim();
        if (!text) return;

        // addTask es asíncrono: en modo invitado detiene la acción y lanza el login
        store.addTask({
            subject: ui.currentActiveSubject,
            text,
            type: dom.taskType.value,
            date: dom.taskDate.value || getLocalDateString(),
        });
        dom.taskInput.value = '';
        dom.taskDate.value = '';
        dom.taskInput.focus();
    });

    /* ============================== Navegación por vistas ============================== */

    dom.navItems.forEach(item => {
        item.addEventListener('click', () => {
            dom.navItems.forEach(n => {
                const active = n === item;
                n.classList.toggle('active', active);
                if (active) n.setAttribute('aria-current', 'page');
                else n.removeAttribute('aria-current');
            });

            const targetView = item.dataset.view;
            dom.appViews.forEach(v => v.classList.toggle('active', v.id === targetView));

            if (targetView === 'calendar-view') renderCalendar();
            if (targetView === 'directory-view') renderDirectory();
            if (targetView === 'resources-view') renderGeneralResources();

            closeSidebar({ restoreFocus: true });
        });
    });

    /* ============================== Controles del horario ============================== */

    function setViewMode(mode) {
        ui.viewMode = mode;
        dom.btnWeekly.classList.toggle('active', mode === 'weekly');
        dom.btnDaily.classList.toggle('active', mode === 'daily');
        dom.btnWeekly.setAttribute('aria-pressed', String(mode === 'weekly'));
        dom.btnDaily.setAttribute('aria-pressed', String(mode === 'daily'));
        dom.daySelect.style.display = mode === 'daily' ? 'inline-block' : 'none';
        refreshDaySelect();
        if (mode === 'daily') dom.daySelect.value = String(ui.selectedDayIndex);
        renderSchedule();
    }

    /**
     * Selector de día (vista "Hoy"): incluye Sábado/Domingo SOLO si tienen
     * actividades agendadas; los días lectivos siempre están disponibles.
     */
    function refreshDaySelect() {
        const hadFocus = document.activeElement === dom.daySelect;
        dom.daySelect.replaceChildren(
            ...DAYS
                .filter(d => !d.weekend || store.extrasOn(d.id).length > 0)
                .map(d => {
                    const opt = el('option', {
                        text: d.weekend ? `${d.name} (actividades)` : d.name,
                    });
                    opt.value = String(d.id);
                    return opt;
                }),
        );
        if (hadFocus) dom.daySelect.focus();
    }

    dom.btnWeekly.addEventListener('click', () => setViewMode('weekly'));
    dom.btnDaily.addEventListener('click', () => setViewMode('daily'));
    dom.daySelect.addEventListener('change', (e) => {
        ui.selectedDayIndex = Number(e.target.value);
        ui.expandedMobileDays.add(ui.selectedDayIndex); // el día elegido se abre en móvil
        renderSchedule();
    });

    /* ============================== Controles del calendario ============================== */

    dom.btnPrevMonth.addEventListener('click', () => {
        ui.currentCalDate = new Date(ui.currentCalDate.getFullYear(), ui.currentCalDate.getMonth() - 1, 1);
        renderCalendar();
    });

    dom.btnNextMonth.addEventListener('click', () => {
        ui.currentCalDate = new Date(ui.currentCalDate.getFullYear(), ui.currentCalDate.getMonth() + 1, 1);
        renderCalendar();
    });

    /* ============================== Búsquedas ============================== */

    dom.directorySearch.addEventListener('input', renderDirectory);
    dom.resourcesSearch.addEventListener('input', renderGeneralResources);

    /* ============================== Tema (persistente + transición suave) ============================== */

    const SUN_SVG = '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>';
    const MOON_SVG = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';

    function applyTheme(theme, { animate = true } = {}) {
        document.documentElement.setAttribute('data-theme', theme);
        dom.themeIcon.innerHTML = theme === 'dark' ? MOON_SVG : SUN_SVG;
        dom.btnTheme.setAttribute('aria-label', theme === 'dark' ? 'Activar tema claro' : 'Activar tema oscuro');
        try { localStorage.setItem(THEME_KEY, theme); } catch { /* noop */ }
        if (animate) {
            // La transición global solo se activa en cambios de tema (evita flash en carga)
            document.body.classList.add('theme-transitioning');
            setTimeout(() => document.body.classList.remove('theme-transitioning'), 320);
        }
    }

    dom.btnTheme.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme') || 'dark';
        applyTheme(current === 'dark' ? 'light' : 'dark');
    });

    /* ============================== Eventos globales ============================== */

    document.addEventListener('keydown', (e) => {
        FocusManager.trapKeydown(e);
        if (e.key === 'Escape') {
            if (ui.sidebarOpen) closeSidebar({ restoreFocus: true });
            else if (dom.editorModal.classList.contains('active')) closeEditor();
            else if (dom.modal.classList.contains('active')) closeOverlay(dom.modal);
        }
    });

    document.addEventListener('store:change', () => {
        refreshDaySelect();
        renderSchedule();
        if ($('#calendar-view').classList.contains('active')) renderCalendar();
        if ($('#directory-view').classList.contains('active')) renderDirectory();
        if (ui.currentActiveSubject && dom.modal.classList.contains('active')) {
            renderTaskList();
            renderGradesList();
            updateAbsenceDisplay();
        }
    });

    dom.btnToggleSidebar.addEventListener('click', () => {
        ui.sidebarOpen ? closeSidebar({ restoreFocus: true }) : openSidebar();
    });
    dom.btnCloseSidebar.addEventListener('click', () => closeSidebar({ restoreFocus: true }));
    dom.sidebarOverlay.addEventListener('click', () => closeSidebar({ restoreFocus: true }));

    dom.btnPrint.addEventListener('click', () => window.print());

    dom.modalClose.addEventListener('click', () => closeOverlay(dom.modal));
    dom.modal.addEventListener('click', (e) => {
        if (e.target === dom.modal) closeOverlay(dom.modal);
    });

    dom.btnEditSubject.addEventListener('click', () => {
        if (ui.activeExtra) {
            closeOverlay(dom.modal);
            openEditor({ mode: 'extra', day: ui.activeExtra.day, start: ui.activeExtra.start });
        } else if (ui.activeSlot) {
            closeOverlay(dom.modal);
            openEditor({ mode: 'normal', dayId: ui.activeSlot.dayId, slotNum: ui.activeSlot.slotNum });
        }
    });

    // "Nueva asignatura" crea SIEMPRE fuera de jornada (horario flexible): nunca toca la parrilla lectiva
    dom.btnAddSubject.addEventListener('click', () => openEditor({ mode: 'extra' }));

    /* ============================== Arranque ============================== */

    function init() {
        let savedTheme = null;
        try { savedTheme = localStorage.getItem(THEME_KEY); } catch { /* noop */ }
        const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
        applyTheme(savedTheme || (prefersLight ? 'light' : 'dark'), { animate: false });

        populateEditorSelects('normal');
        refreshDaySelect();
        renderSchedule();
        renderCalendar();
        renderDirectory();
        renderGeneralResources();

        renderAuthUI();
        AuthSync.boot(); // restaura sesión previa, migra localStorage o descarga users/{uid}

        updateLiveTracker(true);
        setInterval(() => updateLiveTracker(true), 1000);
    }

    init();
})();
