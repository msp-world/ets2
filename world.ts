/**
 * 《欧洲卡车模拟 2 / 美国卡车模拟》副驾 MSP World（移植自 euro-truck2-coopanion）：
 * - 工具：ets2_status, ets2_recent_events, ets2_radar_points, ets2_record_radar
 * - 信号：ets2.speeding, ets2.accident, ets2.job, ets2.radar, ets2.connection
 */
import type { MSPNode } from "../shared/msp.ts";

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export type RadarKind = "speed_camera" | "toll" | "weigh" | "rail" | "police" | "accident" | "fine";

export interface RadarPoint {
  id: string;
  type: RadarKind;
  name: string;
  x: number;
  z: number;
  radiusM: number;
}

export interface Ets2Telemetry {
  connected: boolean;
  game?: "ets2" | "ats";
  speedKmh: number;
  speedLimitKmh: number;
  gear: number;
  fuelPct: number;
  wearEngine: number;
  odometerKm: number;
  x: number;
  y: number;
  z: number;
  job?: {
    cargo?: string;
    sourceCity?: string;
    destinationCity?: string;
    remainingKm?: number;
  };
}

export interface Ets2Config {
  telemetryUrl?: string;
  pollIntervalMs?: number;
}

export class Ets2World {
  private readonly telemetryUrl: string;
  private readonly pollIntervalMs: number;
  private readonly fetchImpl: FetchImpl;
  private node: MSPNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private latest: Ets2Telemetry = {
    connected: false,
    speedKmh: 0,
    speedLimitKmh: 0,
    gear: 0,
    fuelPct: 100,
    wearEngine: 0,
    odometerKm: 0,
    x: 0,
    y: 0,
    z: 0,
  };
  private wasConnected = false;
  private wasSpeeding = false;
  private lastWear = 0;
  private lastJobKey = "";
  private readonly alertedRadars = new Set<string>();
  private readonly radarPoints: RadarPoint[] = [];
  private readonly events: Array<{ type: string; summary: string; at: string }> = [];
  private seq = 1;

  constructor(config: Ets2Config = {}, fetchImpl?: FetchImpl) {
    this.telemetryUrl = config.telemetryUrl ?? "http://127.0.0.1:25555/api/ets2/telemetry";
    this.pollIntervalMs = config.pollIntervalMs ?? 1500;
    this.fetchImpl = fetchImpl ?? ((url, init) => fetch(url, init));
  }

  attach(node: MSPNode): void {
    this.node = node;
    node.declareSignal("ets2.connection", "ETS2/ATS 遥测连接状态变化");
    node.declareSignal("ets2.speeding", "超速提醒");
    node.declareSignal("ets2.accident", "车辆碰撞/损伤增加");
    node.declareSignal("ets2.job", "货运任务开始或变更");
    node.declareSignal("ets2.radar", "接近测速/收费站/称重点提醒");

    node.tool(
      "ets2_status",
      "读取当前 ETS2 / ATS 车况、限速、油量、损伤、坐标与货运任务",
      async () => {
        await this.pollOnce();
        return this.latest as unknown as Record<string, unknown>;
      },
      { type: "object", additionalProperties: false, properties: {} },
    );

    node.tool(
      "ets2_recent_events",
      "返回最近的 ETS2 / ATS 驾驶事件",
      (args) => {
        const limit = typeof args.limit === "number" ? Math.min(Math.max(1, args.limit), 30) : 8;
        return { count: this.events.length, events: this.events.slice(-limit).reverse() };
      },
      { type: "object", properties: { limit: { type: "integer", default: 8 } } },
    );

    node.tool(
      "ets2_radar_points",
      "列出距离当前卡车最近的测速/收费站/称重点",
      (args) => {
        const limit = typeof args.limit === "number" ? Math.min(Math.max(1, args.limit), 30) : 10;
        const list = this.radarPoints
          .map((p) => ({
            ...p,
            distance_m: Math.round(Math.hypot(p.x - this.latest.x, p.z - this.latest.z)),
          }))
          .sort((a, b) => a.distance_m - b.distance_m)
          .slice(0, limit);
        return { count: list.length, points: list };
      },
      { type: "object", properties: { limit: { type: "integer", default: 10 } } },
    );

    node.tool(
      "ets2_record_radar",
      "把卡车当前世界坐标登记为测速/收费站/称重点",
      (args) => {
        const type = String(args.type ?? "speed_camera") as RadarKind;
        const pt: RadarPoint = {
          id: `poi-${this.seq++}`,
          type,
          name: typeof args.name === "string" && args.name.trim() ? args.name.trim() : type,
          x: Math.round(this.latest.x),
          z: Math.round(this.latest.z),
          radiusM: typeof args.radius_m === "number" ? Math.min(Math.max(50, args.radius_m), 5000) : 300,
        };
        this.radarPoints.push(pt);
        return { recorded: pt };
      },
      {
        type: "object",
        required: ["type"],
        properties: {
          type: { type: "string", enum: ["speed_camera", "toll", "weigh", "rail", "police", "accident", "fine"] },
          name: { type: "string" },
          radius_m: { type: "integer", default: 300 },
        },
      },
    );
  }

  start(): void {
    if (this.timer) return;
    void this.pollOnce();
    if (this.pollIntervalMs > 0) {
      this.timer = setInterval(() => void this.pollOnce(), this.pollIntervalMs);
      this.timer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async pollOnce(): Promise<void> {
    try {
      const res = await this.fetchImpl(this.telemetryUrl, { signal: AbortSignal.timeout(1200) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = (await res.json()) as any;
      const connected = Boolean(raw?.game?.connected ?? true);
      const truck = raw?.truck ?? {};
      const nav = raw?.navigation ?? {};
      const job = raw?.job ?? {};
      const place = truck?.placement ?? {};

      const speedKmh = Math.round(Math.abs(Number(truck.speed ?? 0)));
      const speedLimitKmh = Math.round(Number(nav.speedLimit ?? 0));
      const fuelCap = Number(truck.fuelCapacity ?? 0);
      const fuel = Number(truck.fuel ?? 0);
      const fuelPct = fuelCap > 0 ? Math.round((fuel / fuelCap) * 100) : 100;
      const wearEngine = Number(truck.wearEngine ?? 0);

      this.latest = {
        connected,
        game: raw?.game?.gameName === "ATS" ? "ats" : "ets2",
        speedKmh,
        speedLimitKmh,
        gear: Number(truck.gear ?? 0),
        fuelPct,
        wearEngine,
        odometerKm: Math.round(Number(truck.odometer ?? 0)),
        x: Number(place.x ?? 0),
        y: Number(place.y ?? 0),
        z: Number(place.z ?? 0),
        ...(job.destinationCity
          ? {
              job: {
                cargo: job.cargo,
                sourceCity: job.sourceCity,
                destinationCity: job.destinationCity,
                remainingKm: Math.round(Number(nav.estimatedDistance ?? 0) / 1000),
              },
            }
          : {}),
      };

      if (connected !== this.wasConnected) {
        this.wasConnected = connected;
        this.emit("ets2.connection", { connected, game: this.latest.game }, connected ? "已连上 ETS2/ATS 遥测" : "遥测断开");
      }

      const speeding = speedLimitKmh > 0 && speedKmh > speedLimitKmh + 5;
      if (speeding && !this.wasSpeeding) {
        this.emit("ets2.speeding", { speedKmh, speedLimitKmh }, `超速 ${speedKmh} / 限速 ${speedLimitKmh} km/h`);
      }
      this.wasSpeeding = speeding;

      if (wearEngine - this.lastWear > 0.01) {
        this.emit("ets2.accident", { wearEngine }, `车辆损伤增加 (${Math.round(wearEngine * 100)}%)`);
      }
      this.lastWear = wearEngine;

      const jobKey = job.destinationCity ? `${job.sourceCity}->${job.destinationCity}:${job.cargo}` : "";
      if (jobKey && jobKey !== this.lastJobKey) {
        this.lastJobKey = jobKey;
        this.emit("ets2.job", this.latest.job ?? {}, `新货运任务：${job.cargo ?? "货物"} → ${job.destinationCity}`);
      }

      for (const pt of this.radarPoints) {
        const dist = Math.hypot(pt.x - this.latest.x, pt.z - this.latest.z);
        if (dist <= pt.radiusM && !this.alertedRadars.has(pt.id)) {
          this.alertedRadars.add(pt.id);
          this.emit("ets2.radar", { ...pt, distance_m: Math.round(dist) }, `前方 ${Math.round(dist)}m: ${pt.name}`);
        } else if (dist > pt.radiusM * 1.5) {
          this.alertedRadars.delete(pt.id);
        }
      }
    } catch {
      this.latest.connected = false;
      if (this.wasConnected) {
        this.wasConnected = false;
        this.emit("ets2.connection", { connected: false }, "ETS2/ATS 遥测离线");
      }
    }
  }

  private emit(path: string, payload: Record<string, unknown>, summary: string): void {
    this.events.push({ type: path, summary, at: new Date().toISOString() });
    if (this.events.length > 50) this.events.shift();
    this.node?.publish(path, { ...payload, summary });
  }
}
