import type { Express } from 'express';
import { z } from 'zod';
import { apiError } from '../api/api-error.js';
import { requestId } from '../api/request-context.js';
import type { CabinetDefinition } from '../cabinets/cabinet-registry.js';
import type { GameRegistryService } from '../games/game-registry-service.js';
import type { RoomDirectory } from '../rooms/room-directory.js';

const listQuery = z.object({ cursor: z.string().max(96).optional(), limit: z.coerce.number().int().min(1).max(100).default(50),
  sort: z.enum(['id','name']).default('id'), platformId: z.string().max(32).optional(), zoneId: z.string().max(64).optional() }).passthrough();

export function installApiV1Routes(app: Express, dependencies: { cabinets: readonly CabinetDefinition[]; games: GameRegistryService; rooms: RoomDirectory }): void {
  app.get('/api/v1/games', (request, response) => {
    const parsed=listQuery.safeParse(request.query);if(!parsed.success)return apiError(response,400,requestId(request),'INVALID_QUERY','The request query is invalid.');
    let values=dependencies.games.listEnabled();if(parsed.data.platformId)values=values.filter(game=>game.platformId===parsed.data.platformId);
    values.sort((left,right)=>parsed.data.sort==='name'?left.displayName.localeCompare(right.displayName):left.id.localeCompare(right.id));
    const page=paginate(values,parsed.data.cursor,parsed.data.limit,(value)=>value.id).map(game=>({id:game.id,displayName:game.displayName,
      platformId:game.platformId,inputProfileId:game.inputProfileId,replayCapability:game.replayCapability,enabled:game.enabled}));
    response.json({ok:true,data:page.items,pagination:{nextCursor:page.nextCursor,limit:parsed.data.limit},requestId:requestId(request)});
  });
  app.get('/api/v1/cabinets', (request, response) => {
    const parsed=listQuery.safeParse(request.query);if(!parsed.success)return apiError(response,400,requestId(request),'INVALID_QUERY','The request query is invalid.');
    let values=[...dependencies.cabinets];if(parsed.data.zoneId)values=values.filter(cabinet=>cabinet.zoneId===parsed.data.zoneId);
    values.sort((left,right)=>parsed.data.sort==='name'?left.displayName.localeCompare(right.displayName):left.id.localeCompare(right.id));
    const page=paginate(values,parsed.data.cursor,parsed.data.limit,value=>value.id).map(cabinet=>({id:cabinet.id,displayName:cabinet.displayName,
      cabinetType:cabinet.cabinetType,gameId:cabinet.gameId,zoneId:cabinet.zoneId,enabled:cabinet.enabled,interactionPolicy:cabinet.interactionPolicy}));
    response.json({ok:true,data:page.items,pagination:{nextCursor:page.nextCursor,limit:parsed.data.limit},requestId:requestId(request)});
  });
  app.get('/api/v1/rooms', async (request,response)=>{
    const parsed=listQuery.safeParse(request.query);if(!parsed.success)return apiError(response,400,requestId(request),'INVALID_QUERY','The request query is invalid.');
    try{const values=(await dependencies.rooms.list()).sort((a,b)=>a.id.localeCompare(b.id));const page=paginate(values,parsed.data.cursor,parsed.data.limit,value=>value.id)
      .map(room=>({id:room.id,name:room.name,population:room.playerCount,capacity:room.capacity,status:room.status,health:room.health}));
      response.json({ok:true,data:page.items,pagination:{nextCursor:page.nextCursor,limit:parsed.data.limit},requestId:requestId(request)});
    }catch{apiError(response,503,requestId(request),'DIRECTORY_UNAVAILABLE','Room directory is temporarily unavailable.');}
  });
}

function paginate<T>(values:T[],cursor:string|undefined,limit:number,id:(value:T)=>string){const start=cursor?Math.max(0,values.findIndex(value=>id(value)===cursor)+1):0;
  const items=values.slice(start,start+limit),next=start+limit<values.length?id(items.at(-1)!):undefined;return{items,nextCursor:next,map<R>(mapper:(value:T)=>R){return{items:items.map(mapper),nextCursor:next}}}}
