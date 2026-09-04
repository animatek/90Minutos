// Máquina de estados del timer.
//
// Nada de estado en memoria: "hay sesión activa" es la fila con ended_at NULL y
// "está corriendo" es que tenga un segmento con ended_at NULL. El estado se deriva
// siempre de la base de datos, así que un reinicio o un corte de luz no lo pierde.
import { EventEmitter } from 'events';
import { db, getSettings, getTopic, getSession, todaySeconds, nowISO, transaction } from './db.js';

const HEARTBEAT_SEC = 15;

export class Timer extends EventEmitter {
  #tick = null;
  #ticks = 0;
  #alarmFired = false;

  // --- Lectura del estado ----------------------------------------------------

  get activeSession() {
    const row = db.prepare(`SELECT * FROM v_sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1`).get();
    return row || null;
  }

  #openSegment(sessionId) {
    return db.prepare(`SELECT * FROM segments WHERE session_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`).get(sessionId) || null;
  }

  get state() {
    const session = this.activeSession;
    if (!session) return 'idle';
    return this.#openSegment(session.id) ? 'running' : 'paused';
  }

  snapshot() {
    const settings = getSettings();
    const session = this.activeSession;
    const state = !session ? 'idle' : (this.#openSegment(session.id) ? 'running' : 'paused');

    if (!session) {
      const plannedSec = Math.max(60, Math.round(settings.defaultDurationMin * 60));
      return {
        state, mode: settings.defaultMode, sessionId: null,
        topicId: null, topic: '', topicColor: null,
        plannedSec, elapsedSec: 0,
        remainingSec: settings.defaultMode === 'sprint' ? plannedSec : null,
        overtimeSec: 0, startedAtISO: null,
        language: settings.defaultLanguage, sessionType: settings.defaultSessionType,
        url: '', notes: '', todaySec: todaySeconds(),
        // Alias que espera el overlay de OBS.
        category: '', sessionName: '', durationSec: plannedSec,
      };
    }

    const elapsedSec = Number(session.duration_sec) || 0;
    const plannedSec = session.planned_sec ?? null;
    const isSprint = session.mode === 'sprint' && plannedSec != null;

    return {
      state,
      mode: session.mode,
      sessionId: session.id,
      topicId: session.topic_id,
      topic: session.topic_name,
      topicColor: session.topic_color,
      plannedSec,
      elapsedSec,
      remainingSec: isSprint ? Math.max(0, plannedSec - elapsedSec) : null,
      overtimeSec: isSprint ? Math.max(0, elapsedSec - plannedSec) : 0,
      startedAtISO: session.started_at,
      language: session.language || '',
      sessionType: session.session_type || '',
      url: session.url || '',
      notes: session.notes || '',
      todaySec: todaySeconds(),
      category: session.topic_name,
      sessionName: session.topic_name,
      durationSec: isSprint ? plannedSec : elapsedSec,
    };
  }

  #emitState() { this.emit('state', this.snapshot()); }

  // --- Recuperación tras un corte -------------------------------------------

  // Si el proceso murió de golpe, el segmento abierto no tiene fin conocido. Se
  // cierra en el último latido: como mucho se pierden 15 s, en vez de inventar
  // las horas que el equipo pasó apagado.
  recover() {
    const session = this.activeSession;
    if (!session) return null;

    const open = this.#openSegment(session.id);
    if (open) {
      const closeAt = session.heartbeat_at && session.heartbeat_at > open.started_at
        ? session.heartbeat_at
        : open.started_at;
      db.prepare(`UPDATE segments SET ended_at = ? WHERE id = ?`).run(closeAt, open.id);
    }

    // Se queda abierta y en pausa: no perdemos lo acumulado ni inventamos tiempo.
    // El usuario decide si reanuda o cierra.
    const recovered = getSession(session.id);
    this.#alarmFired = false;
    this.#emitState();
    return { session: recovered, interrupted: !!open };
  }

  // --- Comandos --------------------------------------------------------------

  // Arrancar con una sesión en curso la cierra y abre la nueva: es el "cambiar de
  // tema" de un solo gesto que se usa desde la bandeja.
  start({ topicId, mode, plannedSec, language, sessionType, url, notes } = {}) {
    const topic = getTopic(topicId);
    if (!topic) throw new Error('Tema no encontrado');

    const settings = getSettings();
    const useMode = mode || settings.defaultMode;
    if (!['sprint', 'open'].includes(useMode)) throw new Error(`Modo inválido: ${useMode}`);

    const planned = useMode === 'sprint'
      ? Math.max(1, Math.round(Number(plannedSec) || settings.defaultDurationMin * 60))
      : null;

    const previous = this.activeSession ? this.stop({ silent: true }) : null;

    const now = nowISO();
    let id;
    transaction(() => {
      id = db.prepare(`
        INSERT INTO sessions (topic_id, mode, planned_sec, started_at, heartbeat_at,
                              notes, url, language, session_type, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'timer')
      `).run(
        topic.id, useMode, planned, now, now,
        notes ?? null, url ?? null,
        language ?? settings.defaultLanguage ?? null,
        sessionType ?? settings.defaultSessionType ?? null,
      ).lastInsertRowid;
      db.prepare(`INSERT INTO segments (session_id, started_at) VALUES (?, ?)`).run(id, now);
    });

    this.#alarmFired = false;
    this.#startTicking();
    this.#emitState();

    const started = getSession(id);
    this.emit('started', { session: started, previous });
    return { session: started, previous };
  }

  pause() {
    const session = this.activeSession;
    if (!session) throw new Error('No hay sesión activa');
    const open = this.#openSegment(session.id);
    if (!open) return this.snapshot();          // ya estaba en pausa

    db.prepare(`UPDATE segments SET ended_at = ? WHERE id = ?`).run(nowISO(), open.id);
    this.#stopTicking();
    this.#emitState();
    this.emit('paused', getSession(session.id));
    return this.snapshot();
  }

  resume() {
    const session = this.activeSession;
    if (!session) throw new Error('No hay sesión activa');
    if (this.#openSegment(session.id)) return this.snapshot();   // ya corría

    const now = nowISO();
    transaction(() => {
      db.prepare(`INSERT INTO segments (session_id, started_at) VALUES (?, ?)`).run(session.id, now);
      db.prepare(`UPDATE sessions SET heartbeat_at = ? WHERE id = ?`).run(now, session.id);
    });
    this.#startTicking();
    this.#emitState();
    this.emit('resumed', getSession(session.id));
    return this.snapshot();
  }

  stop({ silent = false } = {}) {
    const session = this.activeSession;
    if (!session) throw new Error('No hay sesión activa');

    const now = nowISO();
    transaction(() => {
      const open = this.#openSegment(session.id);
      if (open) db.prepare(`UPDATE segments SET ended_at = ? WHERE id = ?`).run(now, open.id);

      // El fin de la sesión es el último instante trabajado, no el momento de
      // pulsar "parar": así una pausa larga antes de cerrar no la infla.
      const last = db.prepare(`SELECT MAX(ended_at) AS last FROM segments WHERE session_id = ?`).get(session.id);
      db.prepare(`UPDATE sessions SET ended_at = ?, heartbeat_at = ? WHERE id = ?`)
        .run(last?.last || now, now, session.id);
    });

    this.#stopTicking();
    this.#alarmFired = false;
    const finished = getSession(session.id);
    if (!silent) {
      this.#emitState();
      this.emit('complete', finished);
    }
    return finished;
  }

  // Descartar: la sesión no se guarda en el historial (el antiguo "reset").
  discard() {
    const session = this.activeSession;
    if (!session) return null;
    const discarded = getSession(session.id);
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(session.id);
    this.#stopTicking();
    this.#alarmFired = false;
    this.#emitState();
    this.emit('discarded', discarded);
    return discarded;
  }

  // Sumar o restar tiempo al objetivo del sprint (no toca lo ya trabajado).
  extend(sec) {
    const session = this.activeSession;
    if (!session) throw new Error('No hay sesión activa');
    if (session.mode !== 'sprint') throw new Error('Solo el modo sprint tiene objetivo que extender');
    const planned = Math.max(60, (session.planned_sec || 0) + (Number(sec) || 0));
    db.prepare(`UPDATE sessions SET planned_sec = ? WHERE id = ?`).run(planned, session.id);
    if (planned > (Number(session.duration_sec) || 0)) this.#alarmFired = false;
    this.#emitState();
    return this.snapshot();
  }

  setMode(mode, plannedSec) {
    const session = this.activeSession;
    if (!session) throw new Error('No hay sesión activa');
    if (!['sprint', 'open'].includes(mode)) throw new Error(`Modo inválido: ${mode}`);
    const settings = getSettings();
    const planned = mode === 'sprint'
      ? Math.max(60, Math.round(Number(plannedSec) || session.planned_sec || settings.defaultDurationMin * 60))
      : null;
    db.prepare(`UPDATE sessions SET mode = ?, planned_sec = ? WHERE id = ?`).run(mode, planned, session.id);
    this.#alarmFired = false;
    this.#emitState();
    return this.snapshot();
  }

  setMeta({ url, notes, language, sessionType, topicId } = {}) {
    const session = this.activeSession;
    if (!session) throw new Error('No hay sesión activa');
    const fields = [];
    const values = [];
    if (url !== undefined) { fields.push('url = ?'); values.push(String(url ?? '')); }
    if (notes !== undefined) { fields.push('notes = ?'); values.push(String(notes ?? '')); }
    if (language !== undefined) { fields.push('language = ?'); values.push(String(language ?? '')); }
    if (sessionType !== undefined) { fields.push('session_type = ?'); values.push(String(sessionType ?? '')); }
    if (topicId !== undefined) {
      const topic = getTopic(topicId);
      if (!topic) throw new Error('Tema no encontrado');
      fields.push('topic_id = ?'); values.push(topic.id);
    }
    if (fields.length) {
      values.push(session.id);
      db.prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`).run(...values);
      this.#emitState();
    }
    return this.snapshot();
  }

  // --- Latido ----------------------------------------------------------------

  #startTicking() {
    if (this.#tick) return;
    this.#ticks = 0;
    this.#tick = setInterval(() => this.#onTick(), 1000);
  }

  #stopTicking() {
    if (!this.#tick) return;
    clearInterval(this.#tick);
    this.#tick = null;
  }

  // El tick solo publica y vigila; nunca decrementa un contador. El tiempo sale
  // siempre de los timestamps, así que da igual si el tick se retrasa o se salta.
  #onTick() {
    const session = this.activeSession;
    if (!session || !this.#openSegment(session.id)) { this.#stopTicking(); return; }

    this.#ticks++;
    if (this.#ticks % HEARTBEAT_SEC === 0) {
      db.prepare(`UPDATE sessions SET heartbeat_at = ? WHERE id = ?`).run(nowISO(), session.id);
    }

    const elapsed = Number(session.duration_sec) || 0;
    const planned = session.planned_sec;
    if (session.mode === 'sprint' && planned != null && elapsed >= planned && !this.#alarmFired) {
      this.#alarmFired = true;
      if (getSettings().autoStopOnSprintEnd) {
        this.stop();
        return;
      }
      this.emit('sprint:end', this.snapshot());   // prórroga: sigue contando
    }

    this.#emitState();
  }

  // Un latido final al apagar para que un reinicio ordenado no pierda segundos.
  shutdown() {
    const session = this.activeSession;
    if (session && this.#openSegment(session.id)) {
      db.prepare(`UPDATE sessions SET heartbeat_at = ? WHERE id = ?`).run(nowISO(), session.id);
    }
    this.#stopTicking();
  }

  // Retoma el conteo si al arrancar hay una sesión que quedó corriendo.
  resumeTickingIfRunning() {
    const session = this.activeSession;
    if (session && this.#openSegment(session.id)) this.#startTicking();
  }
}

export const timer = new Timer();
