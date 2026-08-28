import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { access, readFile } from 'node:fs/promises';

const root = process.cwd();
const arcade = await readFile(path.resolve(root, 'arcade.js'), 'utf8');

function statueSlugs(): string[] {
  const block = /const MEGAMAN_STATUES=\[([\s\S]*?)\];/.exec(arcade)?.[1] ?? '';
  return [...block.matchAll(/\['([a-z0-9-]+)',(-?[\d.]+)\]/g)].map((match) => match[1]);
}

function statueAspects(): number[] {
  const block = /const MEGAMAN_STATUES=\[([\s\S]*?)\];/.exec(arcade)?.[1] ?? '';
  return [...block.matchAll(/\['[a-z0-9-]+',([\d.]+)\]/g)].map((match) => Number(match[1]));
}

function numberOf(name: string): number {
  const value = new RegExp(`${name}=(-?[\\d.]+)`).exec(arcade)?.[1];
  assert.ok(value !== undefined, `${name} is missing`);
  return Number(value);
}

void test('every statue in the line has a model shipped for it', async () => {
  const slugs = statueSlugs();
  assert.ok(slugs.length >= 1, 'the statue line must name its models');
  for (const slug of slugs) {
    await assert.doesNotReject(
      access(path.resolve(root, `assets/models/megaman/${slug}.optimized.glb`)),
      `assets/models/megaman/${slug}.optimized.glb is named by the room but missing`
    );
  }
  // Meshopt-compressed, because that is the loader the room asks for.
  assert.match(arcade, /assets\/models\/megaman\/\$\{slug\}\.optimized\.glb/);
  assert.match(arcade, /getOptimizedGltfLoader\(\)/);
});

void test('the statues fit the wall they stand against at the height they are set to', () => {
  // The failure this replaces: the line was spaced evenly, the height went up,
  // and figures ended up standing inside one another. Spacing follows from the
  // width each model actually occupies, so the check is that the widths plus
  // their gaps still fit the wall — whatever the height is changed to next.
  const height = numberOf('MEGAMAN_STATUE_HEIGHT');
  const gap = numberOf('MEGAMAN_STATUE_GAP');
  const run = /\{along:'x',from:(-?[\d.]+),to:(-?[\d.]+)/.exec(arcade);
  assert.ok(run, 'the statues must name the wall they are packed along');
  const capacity = Math.abs(Number(run[2]) - Number(run[1]));
  const aspects = statueAspects();
  assert.equal(aspects.length, statueSlugs().length, 'every statue carries the width it occupies');
  const needed = aspects.reduce((total, aspect) => total + aspect * height, 0) + gap * (aspects.length - 1);
  assert.ok(needed <= capacity, `${needed.toFixed(1)}m of statue does not fit a ${capacity.toFixed(1)}m wall at height ${height}`);
  // Narrowest first, so anything that does overflow is the one figure that has
  // to turn the corner rather than an arbitrary one.
  assert.deepEqual(aspects, [...aspects].sort((first, second) => first - second));
  assert.match(arcade, /MEGAMAN_STATUE_MAX_SPAN\/Math\.max\(size\.x,size\.z,\.001\)/, 'a wide pose must be capped, not left to reach into the next statue');
});

void test('a statue with nowhere left to stand turns the corner or says so', () => {
  assert.match(arcade, /const MEGAMAN_STATUE_RUNS=\[/);
  assert.equal((arcade.match(/\{along:'[xz]',from:/g) ?? []).length, 2, 'the gallery continues onto a second wall');
  assert.match(arcade, /No wall left in the Mega Man room for the \$\{slug\} statue/);
  // Centred on its wall rather than pushed up against the doorway end.
  assert.match(arcade, /cursor=first\.from\+Math\.sign\(first\.to-first\.from\)\*\(capacity-used\)\/2/);
});

void test('the statue line loads on approach and is solid to walk into', () => {
  // Several megabytes of models: loaded when a player is in the room, not at
  // boot, in the same pass that warms cabinets and prize models.
  assert.match(arcade, /megaManStatuesStarted=true;installMegaManStatues\(\)/);
  assert.match(arcade, /function loadNearbySceneModels\(now\)/);
  // Footprint comes from the model that actually loaded, not one guess for all.
  assert.match(arcade, /entry\.radius=Math\.min\(1\.15,Math\.max\(MEGAMAN_STATUE_RADIUS/);
  assert.match(arcade, /const \{mount,radius\} of megaManStatueMounts/);
  // And the check costs nothing anywhere else in the arcade: a player outside
  // the room fails one comparison and never touches the gallery.
  assert.match(arcade, /function resolveStatueCollisions\(previousX,previousZ\)\{\s*if\(playerPosition\.x>-15\.2\)return;/);
});

void test('the murals light the room from their own bright regions', () => {
  assert.match(arcade, /addMuralMoodLights\(texture,\{center:/, 'each mural must contribute its own light');
  // Call sites, not the declaration, which matches the same opening.
  assert.equal((arcade.match(/addMuralMoodLights\(texture,\{center:/g) ?? []).length, 3, 'all three Mega Man room murals light the room');
  // Sampled from the image rather than hand-placed, and pulled toward one
  // accent so three different images read as one room.
  assert.match(arcade, /context\.drawImage\(image,0,0,MURAL_MOOD_COLUMNS,MURAL_MOOD_ROWS\)/);
  assert.match(arcade, /\.lerp\(MURAL_MOOD_ACCENT,\.5\)/);
  // Standing off the wall: against it, the light only rims whatever is in
  // front of it, which is precisely where the statues stand.
  assert.match(arcade, /MURAL_MOOD_STANDOFF=2\.6/);
  assert.match(arcade, /MURAL_MOOD_MIN_LUMINANCE/, 'only the bright regions become lights');
});

void test('mural lights are budgeted over the range they actually reach', () => {
  // On the accent budget — two lights within four metres — every one of these
  // sat dark unless the player pressed into the wall, which is the one place
  // the wash cannot be seen.
  assert.match(arcade, /light\.userData\.muralLight=true/);
  assert.match(arcade, /muralLights\.sort\(\(a,b\)=>a\.distanceSq-b\.distanceSq\)\.forEach\(\(\{light,distanceSq\},index\)=>\{light\.visible=index<3&&distanceSq<225\}\)/);
});

void test('the room has seats for the games still to come', () => {
  // Up to seven more Mega Man games are expected. A seat positioned by hand is
  // a seat that ends up inside a wall, so position comes from the order.
  const runs = [...arcade.matchAll(/\{seats:(\d+),x:/g)].map((match) => Number(match[1]));
  const order = /const MEGAMAN_CABINET_ORDER=\[([\d,]+)\]/.exec(arcade)?.[1].split(',').length ?? 0;
  assert.ok(runs.length >= 2, 'the room fills in runs, not one row');
  const seats = runs.reduce((total, run) => total + run, 0);
  assert.ok(seats >= order + 7, `${seats} seats for ${order} cabinets leaves no room for the seven still coming`);
  assert.match(arcade, /const megaManCabinetLayout=MEGAMAN_CABINET_ORDER\.map/);
});

void test('a cabinet added beyond the current ten still gets a colour and a place', () => {
  // A fixed hue map gave an unlisted index no colour at all, and a hardcoded
  // layout gave it no position — both silent.
  assert.match(arcade, /const megaManHue=index=>megaManHues\[index\]\?\?MEGAMAN_HUE_CYCLE\[\(index-1\)%MEGAMAN_HUE_CYCLE\.length\]/);
  assert.match(arcade, /makeCabinet\(cabinetId,label,x,z,megaManHue\(index\)/);
  assert.doesNotMatch(arcade, /megaManHues\[index\],false,false,system/, 'the raw hue map must not be read directly any more');
  // And one that genuinely has nowhere to go says so instead of landing at the
  // origin, in the middle of the hub.
  assert.match(arcade, /No seat left in the Mega Man room for cabinet/);
});

void test('the Mega Man room models ship with the Pages bundle', async () => {
  // assets/models is allow-listed, so a directory the arcade loads from and
  // the bundle skips is a room of empty floor in production.
  const build = await readFile(path.resolve(root, 'tools/build-pages.mjs'), 'utf8');
  assert.match(build, /normalized\.startsWith\('assets\/models\/megaman\/'\)\) return true/);
});
