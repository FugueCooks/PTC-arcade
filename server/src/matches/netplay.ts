import type { Match, MatchSeat } from '../domain/match.js';
import { hostOf } from '../domain/match.js';

/**
 * Connecting the players in a match to each other.
 *
 * A match says who is playing together and in what seat order. Turning that
 * into a shared game is a per-platform problem: Dolphin, RetroArch and Play!
 * each have their own answer, and one of them has no answer at all. So the
 * platform-specific part is a transport, and everything above it works from the
 * same plan.
 *
 * The plan is computed once, on the server, from the match. Seat zero hosts —
 * decided already by the match, not renegotiated here — and every other seat is
 * told where to connect. Nothing about this is left to the clients to agree on
 * between themselves.
 */

/**
 * How much of the connecting a transport can actually do.
 *
 * Stated rather than assumed, because the difference is what a player has to be
 * told. Dolphin exposes no netplay command line, so the runtime can fill in
 * every field and the player still presses Connect; calling that `full` would
 * mean the arcade says a match is connecting when it is in fact waiting for
 * somebody to click something they have not been told about.
 */
export type NetplayAutomation = 'full' | 'assisted' | 'none';

export interface NetplayTransport {
  id: string;
  supportedPlatforms: readonly string[];
  automation: NetplayAutomation;
  /** Shown to the player when the transport cannot finish the job itself. */
  playerInstruction: string | null;
}

export interface NetplaySeatPlan {
  seatIndex: number;
  playerId: string;
  role: 'host' | 'guest';
  /**
   * Where to connect. Null for the host, who connects to nobody, and null when
   * the transport does not need an address.
   *
   * This is another player's address, so it is placed only in the plans of
   * seats that need it, and a seat's plan is only ever sent to that seat.
   */
  hostAddress: string | null;
  port: number;
  nickname: string;
}

export interface NetplayPlan {
  matchId: string;
  transportId: string;
  automation: NetplayAutomation;
  playerInstruction: string | null;
  port: number;
  seats: NetplaySeatPlan[];
}

export type NetplayFailure =
  | { ok: false; reason: 'no-transport'; platformId: string }
  /** A transport exists and states that it cannot connect players at all. */
  | { ok: false; reason: 'transport-cannot-connect'; platformId: string; transportId: string }
  | { ok: false; reason: 'no-port' }
  | { ok: false; reason: 'no-host' }
  | { ok: false; reason: 'host-address-unknown' }
  | { ok: false; reason: 'not-enough-players' };

export type NetplayPlanResult = { ok: true; plan: NetplayPlan } | NetplayFailure;

/**
 * The transports the arcade ships.
 *
 * Registered rather than hardcoded so a new console arrives as an entry here
 * plus its own implementation, and so a platform with no netplay is a stated
 * fact rather than a silent gap.
 */
export class NetplayTransportRegistry {
  #byId = new Map<string, NetplayTransport>();
  #byPlatform = new Map<string, NetplayTransport>();

  register(transport: NetplayTransport): NetplayTransport {
    if (this.#byId.has(transport.id)) throw new Error(`Duplicate netplay transport: ${transport.id}`);
    if (transport.automation !== 'none' && !transport.playerInstruction && transport.automation === 'assisted') {
      // An assisted transport that says nothing leaves the player looking at an
      // emulator wondering why nobody has joined.
      throw new Error(`Transport ${transport.id} is assisted but tells the player nothing.`);
    }
    this.#byId.set(transport.id, transport);
    for (const platform of transport.supportedPlatforms) {
      if (!this.#byPlatform.has(platform)) this.#byPlatform.set(platform, transport);
    }
    return transport;
  }

  get(id: string): NetplayTransport | undefined { return this.#byId.get(id); }
  forPlatform(platformId: string): NetplayTransport | undefined { return this.#byPlatform.get(platformId); }
  all(): readonly NetplayTransport[] { return [...this.#byId.values()]; }
}

/** Ports handed to concurrent matches, so two sessions never listen on one. */
export class PortAllocator {
  #inUse = new Set<number>();
  #from: number;
  #to: number;

  constructor({ from = 2626, to = 2700 } = {}) {
    this.#from = from;
    this.#to = to;
  }

  claim(): number | null {
    for (let port = this.#from; port <= this.#to; port += 1) {
      if (!this.#inUse.has(port)) { this.#inUse.add(port); return port; }
    }
    return null;
  }

  release(port: number): void { this.#inUse.delete(port); }
  get size(): number { return this.#inUse.size; }
}

export interface PlanInput {
  match: Match;
  platformId: string;
  transports: NetplayTransportRegistry;
  /** Where a seated player is connected from, as the server saw it. */
  addressOf: (playerId: string) => string | undefined;
  allocatePort: () => number | null;
}

/**
 * Turns a match into a plan, or says why it cannot.
 *
 * Refuses rather than improvises. A platform with no transport produces
 * `no-transport`, which the arcade shows as "you will be playing separate
 * games" — the players still get to sit at the cabinet together, and are not
 * told they are connected when they are not.
 */
export function planNetplay(input: PlanInput): NetplayPlanResult {
  const { match, platformId, transports, addressOf, allocatePort } = input;

  const transport = transports.forPlatform(platformId);
  if (!transport) return { ok: false, reason: 'no-transport', platformId };
  // A transport that declares `none` is a stated fact, not a gap: the arcade
  // shows "you will be playing separate games" rather than reporting a session
  // that will never connect.
  if (transport.automation === 'none') {
    return { ok: false, reason: 'transport-cannot-connect', platformId, transportId: transport.id };
  }
  if (match.seats.length < 2) return { ok: false, reason: 'not-enough-players' };

  const host = hostOf(match);
  if (!host) return { ok: false, reason: 'no-host' };

  const hostAddress = addressOf(host.playerId);
  if (!hostAddress) return { ok: false, reason: 'host-address-unknown' };

  const port = allocatePort();
  if (port === null) return { ok: false, reason: 'no-port' };

  return {
    ok: true,
    plan: {
      matchId: match.matchId,
      transportId: transport.id,
      automation: transport.automation,
      playerInstruction: transport.playerInstruction,
      port,
      seats: match.seats.map((seat) => toSeatPlan(seat, host, hostAddress, port))
    }
  };
}

function toSeatPlan(seat: MatchSeat, host: MatchSeat, hostAddress: string, port: number): NetplaySeatPlan {
  const isHost = seat.seatIndex === host.seatIndex;
  return {
    seatIndex: seat.seatIndex,
    playerId: seat.playerId,
    role: isHost ? 'host' : 'guest',
    // The host connects to nobody, so their plan carries no address at all.
    hostAddress: isHost ? null : hostAddress,
    port,
    nickname: seat.displayName
  };
}

/**
 * One seat's share of a plan.
 *
 * Used to send each player only their own instructions. A plan contains another
 * player's address, and broadcasting the whole thing to the room would hand it
 * to everyone present rather than to the three people who need it to connect.
 */
export function seatPlanFor(plan: NetplayPlan, playerId: string): NetplaySeatPlan | null {
  return plan.seats.find((seat) => seat.playerId === playerId) ?? null;
}
