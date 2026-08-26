import type { CabinetDefinition } from '../../../domain/cabinet-definition.js';
import type { GameDefinition } from '../../../domain/game-definition.js';
import type { ZoneDefinition } from '../../../cabinets/zone-registry.js';

/**
 * Milestone 11.31 — versioned response DTOs.
 *
 * Every field a client receives is written out by hand here. That is the point:
 * the API never returns an internal model or spreads one into a response, so a
 * field added to a domain type or an ORM row cannot silently become public.
 * Milestone 11.30's "do not expose internal database models" is enforced by
 * these functions being the only path to the wire.
 */

export interface CabinetSummaryDto {
  id: string;
  displayName: string;
  cabinetType: string;
  zoneId: string;
  gameId: string | null;
  enabled: boolean;
}

export interface CabinetDetailDto extends CabinetSummaryDto {
  interactionPosition: { x: number; y: number; z: number };
  playerPosition: { x: number; y: number; z: number };
  playerRotationY: number;
  interactionDistance: number;
}

export function toCabinetSummaryDto(definition: CabinetDefinition): CabinetSummaryDto {
  return {
    id: definition.id,
    displayName: definition.displayName,
    cabinetType: definition.cabinetType,
    zoneId: definition.zoneId,
    gameId: definition.gameId,
    enabled: definition.enabled
  };
}

export function toCabinetDetailDto(definition: CabinetDefinition): CabinetDetailDto {
  return {
    ...toCabinetSummaryDto(definition),
    interactionPosition: { ...definition.interactionPosition },
    playerPosition: { ...definition.playerPosition },
    playerRotationY: definition.playerRotationY,
    interactionDistance: definition.interactionPolicy.interactionDistance
  };
}

export interface GameSummaryDto {
  id: string;
  displayName: string;
  platformId: string;
  replayCapability: string;
  enabled: boolean;
}

export interface GameDetailDto extends GameSummaryDto {
  launcherAdapterId: string;
  emulatorAdapterId: string | null;
  inputProfileId: string;
  /** Sizes and kinds only. Asset IDs are omitted: a public catalogue has no
   *  business advertising ROM file names. */
  assets: Array<{ kind: string; sizeBytes: number | null; required: boolean; label: string | null }>;
}

export function toGameSummaryDto(game: GameDefinition): GameSummaryDto {
  return {
    id: game.id,
    displayName: game.displayName,
    platformId: game.platformId,
    replayCapability: game.replayCapability,
    enabled: game.enabled
  };
}

export function toGameDetailDto(game: GameDefinition): GameDetailDto {
  return {
    ...toGameSummaryDto(game),
    launcherAdapterId: game.launcherAdapterId,
    emulatorAdapterId: game.emulatorAdapterId ?? null,
    inputProfileId: game.inputProfileId,
    assets: game.assetRequirements.map((asset) => ({
      kind: asset.kind,
      sizeBytes: asset.sizeBytes,
      required: asset.required,
      label: asset.label
    }))
  };
}

export interface ZoneDto {
  id: string;
  cabinetCount: number;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  adjacentZoneIds: string[];
  preloadDistance: number;
}

export function toZoneDto(zone: ZoneDefinition): ZoneDto {
  return {
    id: zone.id,
    cabinetCount: zone.cabinetIds.length,
    bounds: { ...zone.bounds },
    adjacentZoneIds: [...zone.adjacentZoneIds],
    preloadDistance: zone.preloadDistance
  };
}

export interface RoomSummaryDto {
  id: string;
  name: string;
  population: number;
  capacity: number;
  acceptsPlayers: boolean;
}

export interface PlatformInfoDto {
  apiVersion: string;
  deploymentVersion: string;
  cabinetDefinitions: number;
  gameDefinitions: number;
  zones: number;
  emulatorAdapters: Array<{ id: string; platforms: string[] }>;
  /** Declared honestly: Phase 11 ships no replay system. */
  replaySupported: false;
}
