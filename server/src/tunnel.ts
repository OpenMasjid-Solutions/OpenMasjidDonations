// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Cloudflare Tunnel supervisor. When the admin saves a tunnel token, we run the
 * bundled `cloudflared` as a child process so the masjid can take donations from
 * the public internet WITHOUT port-forwarding or opening any inbound ports —
 * cloudflared makes outbound connections only and routes the admin's chosen
 * hostname → this app (http://localhost:PORT, configured in the Cloudflare
 * dashboard). It's optional: with no token the app stays LAN-only.
 *
 * The token is a CREDENTIAL — it is passed to cloudflared via argv on the masjid's
 * own machine but is NEVER logged here or returned to the browser.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { config } from './config';
import { makeLog } from './logger';

const log = makeLog('tunnel');

export type TunnelState = 'stopped' | 'starting' | 'running' | 'error';

// cloudflared prints a line like "Registered tunnel connection connIndex=0 …" once
// it has an edge connection — our signal that the tunnel is actually up.
const CONNECTED_RE = /registered tunnel connection|connection .*registered|each tunnel connection/i;

export class TunnelManager {
  private proc: ChildProcess | null = null;
  private token = '';
  private enabled = false;
  private state: TunnelState = 'stopped';
  private message = '';
  private restartTimer: NodeJS.Timeout | null = null;
  private backoffMs = 2000;
  private stopping = false;

  /** Apply the desired config: (re)start when enabled + token present, else stop. */
  apply(token: string, enabled: boolean): void {
    const changed = token !== this.token || enabled !== this.enabled;
    this.token = token;
    this.enabled = enabled;
    if (!enabled || !token) {
      this.stop();
      return;
    }
    if (changed || !this.proc) {
      this.start();
    }
  }

  status(): { state: TunnelState; message: string; enabled: boolean } {
    return { state: this.state, message: this.message, enabled: this.enabled };
  }

  private clearRestart(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  stop(): void {
    this.stopping = true;
    this.clearRestart();
    if (this.proc) {
      try {
        this.proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      this.proc = null;
    }
    this.state = 'stopped';
    this.message = '';
    this.stopping = false;
  }

  private start(): void {
    this.clearRestart();
    // Replace any existing process.
    if (this.proc) {
      this.stopping = true;
      try {
        this.proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      this.proc = null;
      this.stopping = false;
    }
    this.state = 'starting';
    this.message = 'Connecting to Cloudflare…';
    log.info('starting cloudflared tunnel');

    // `run --token <token>` is the remote-managed tunnel model: the admin created
    // the tunnel + hostname route in the Cloudflare dashboard and pasted the token.
    let child: ChildProcess;
    try {
      child = spawn(config.cloudflaredBin, ['tunnel', '--no-autoupdate', 'run', '--token', this.token], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.state = 'error';
      this.message = 'Could not start the tunnel on this machine.';
      log.warn('cloudflared spawn failed: ' + (err instanceof Error ? err.message : String(err)));
      return;
    }
    this.proc = child;

    const onData = (buf: Buffer) => {
      const text = buf.toString();
      // NEVER log raw cloudflared output — it can echo the token/URL. Only react.
      if (this.state !== 'running' && CONNECTED_RE.test(text)) {
        this.state = 'running';
        this.message = 'Connected — your donation pages are reachable publicly.';
        this.backoffMs = 2000; // reset backoff on a healthy connection
        log.info('cloudflared tunnel connected');
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    child.on('exit', (code) => {
      if (this.proc !== child) return; // superseded by a newer start
      this.proc = null;
      if (this.stopping || !this.enabled) {
        this.state = 'stopped';
        return;
      }
      // Unexpected exit → mark error and retry with backoff while still enabled.
      this.state = 'error';
      this.message = 'Tunnel disconnected — retrying…';
      log.warn(`cloudflared exited (code ${code ?? 'null'}); retrying in ${Math.round(this.backoffMs / 1000)}s`);
      this.restartTimer = setTimeout(() => {
        if (this.enabled && this.token) this.start();
      }, this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
    });

    child.on('error', (err) => {
      if (this.proc !== child) return;
      this.state = 'error';
      // A missing binary (e.g. local dev without cloudflared) lands here.
      this.message = /ENOENT/.test(String(err)) ? 'cloudflared isn’t available on this machine.' : 'Tunnel error.';
      log.warn('cloudflared process error: ' + (err instanceof Error ? err.message : String(err)));
    });
  }
}
