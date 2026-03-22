// ══════════════════════════════════════════════════════════════
// LOL COACH PRO — Backend API Server
// Riot API proxy + Lolalytics data + Data Dragon enrichment
// ══════════════════════════════════════════════════════════════

import 'dotenv/config';
import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3001;

// ── Config ──────────────────────────────────────
const RIOT_KEY = process.env.RIOT_API_KEY;
const REGION = process.env.RIOT_REGION || 'euw1';
const ROUTING = process.env.RIOT_ROUTING || 'europe';

const RIOT_BASE = `https://${REGION}.api.riotgames.com`;
const RIOT_ROUTING_BASE = `https://${ROUTING}.api.riotgames.com`;

// ── Middleware ───────────────────────────────────
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

// ── Helpers ─────────────────────────────────────
async function riotFetch(url) {
  const res = await fetch(url, {
    headers: { 'X-Riot-Token': RIOT_KEY }
  });
  if (!res.ok) {
    const status = res.status;
    const body = await res.text().catch(() => '');
    if (status === 404) throw { status: 404, message: 'Joueur non trouvé' };
    if (status === 403) throw { status: 403, message: 'Clé API invalide ou expirée — va sur developer.riotgames.com' };
    if (status === 429) throw { status: 429, message: 'Rate limit Riot — attends 2 minutes' };
    throw { status, message: `Erreur Riot API: ${status} ${body}` };
  }
  return res.json();
}

async function lolaltyicsFetch(endpoint) {
  const res = await fetch(`https://ax.lolalytics.com/mega/?${endpoint}`, {
    headers: { 'Referer': 'https://lolalytics.com' }
  });
  if (!res.ok) throw { status: res.status, message: 'Erreur Lolalytics' };
  return res.json();
}

// Cache simple en mémoire pour Data Dragon (noms des items, champions)
let ddCache = { items: null, champions: null, version: null };

async function getDataDragon() {
  if (ddCache.items && ddCache.champions) return ddCache;
  
  // Récupérer la dernière version
  const versions = await fetch('https://ddragon.leagueoflegends.com/api/versions.json').then(r => r.json());
  const version = versions[0];
  
  // Items
  const itemsData = await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/fr_FR/item.json`).then(r => r.json());
  
  // Champions
  const champsData = await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/fr_FR/champion.json`).then(r => r.json());
  
  ddCache = {
    version,
    items: itemsData.data,
    champions: champsData.data,
    championById: Object.fromEntries(
      Object.values(champsData.data).map(c => [c.key, c])
    )
  };
  
  console.log(`📦 Data Dragon ${version} chargé — ${Object.keys(ddCache.items).length} items, ${Object.keys(ddCache.champions).length} champions`);
  return ddCache;
}

function enrichItem(itemId, dd) {
  const item = dd.items[String(itemId)];
  if (!item) return { id: itemId, name: `Item #${itemId}`, image: null, cost: 0, stats: {} };
  return {
    id: itemId,
    name: item.name,
    description: item.plaintext || '',
    image: `https://ddragon.leagueoflegends.com/cdn/${dd.version}/img/item/${itemId}.png`,
    cost: item.gold?.total || 0,
    stats: item.stats || {},
    tags: item.tags || [],
  };
}

function enrichChampion(championId, dd) {
  const champ = dd.championById[String(championId)];
  if (!champ) return { id: championId, name: `Champion #${championId}`, image: null };
  return {
    id: championId,
    name: champ.name,
    title: champ.title,
    image: `https://ddragon.leagueoflegends.com/cdn/${dd.version}/img/champion/${champ.image.full}`,
    tags: champ.tags,
  };
}

// ── Error handler ───────────────────────────────
function handleError(res, err) {
  const status = err.status || 500;
  const message = err.message || 'Erreur serveur';
  console.error(`❌ ${status}: ${message}`);
  res.status(status).json({ error: message });
}

// ══════════════════════════════════════════════════
// ROUTES — RIOT API
// ══════════════════════════════════════════════════

// ── 1. Rechercher un joueur par Riot ID (GameName#Tag) ──
// GET /api/summoner/:gameName/:tagLine
app.get('/api/summoner/:gameName/:tagLine', async (req, res) => {
  try {
    const { gameName, tagLine } = req.params;
    
    // Étape 1: Riot ID → PUUID (via routing regional)
    const account = await riotFetch(
      `${RIOT_ROUTING_BASE}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`
    );
    
    // Étape 2: PUUID → Summoner data (niveau, icône)
    const summoner = await riotFetch(
      `${RIOT_BASE}/lol/summoner/v4/summoners/by-puuid/${account.puuid}`
    );
    
    // Étape 3: Ranked stats
    const ranked = await riotFetch(
      `${RIOT_BASE}/lol/league/v4/entries/by-summoner/${summoner.id}`
    );
    
    const soloQ = ranked.find(r => r.queueType === 'RANKED_SOLO_5x5');
    const flex = ranked.find(r => r.queueType === 'RANKED_FLEX_SR');
    
    const dd = await getDataDragon();
    
    res.json({
      puuid: account.puuid,
      gameName: account.gameName,
      tagLine: account.tagLine,
      summonerLevel: summoner.summonerLevel,
      profileIcon: `https://ddragon.leagueoflegends.com/cdn/${dd.version}/img/profileicon/${summoner.profileIconId}.png`,
      soloQ: soloQ ? {
        tier: soloQ.tier,
        rank: soloQ.rank,
        lp: soloQ.leaguePoints,
        wins: soloQ.wins,
        losses: soloQ.losses,
        winRate: ((soloQ.wins / (soloQ.wins + soloQ.losses)) * 100).toFixed(1),
      } : null,
      flex: flex ? {
        tier: flex.tier,
        rank: flex.rank,
        lp: flex.leaguePoints,
        wins: flex.wins,
        losses: flex.losses,
      } : null,
    });
  } catch (err) {
    handleError(res, err);
  }
});

// ── 2. Récupérer les dernières games ──
// GET /api/matches/:puuid?count=20&type=ranked
app.get('/api/matches/:puuid', async (req, res) => {
  try {
    const { puuid } = req.params;
    const count = Math.min(parseInt(req.query.count) || 20, 50);
    const type = req.query.type || 'ranked'; // ranked, normal, all
    
    // Liste des match IDs
    const typeParam = type === 'all' ? '' : `&type=${type}`;
    const matchIds = await riotFetch(
      `${RIOT_ROUTING_BASE}/lol/match/v5/matches/by-puuid/${puuid}/ids?count=${count}${typeParam}`
    );
    
    // Récupérer le détail de chaque game (en parallèle par batch de 5)
    const dd = await getDataDragon();
    const games = [];
    
    for (let i = 0; i < matchIds.length; i += 5) {
      const batch = matchIds.slice(i, i + 5);
      const results = await Promise.all(
        batch.map(id => riotFetch(`${RIOT_ROUTING_BASE}/lol/match/v5/matches/${id}`).catch(() => null))
      );
      
      for (const match of results) {
        if (!match) continue;
        
        const player = match.info.participants.find(p => p.puuid === puuid);
        if (!player) continue;
        
        const enemies = match.info.participants.filter(p => p.teamId !== player.teamId);
        const allies = match.info.participants.filter(p => p.teamId === player.teamId && p.puuid !== puuid);
        
        // Items du joueur (slots 0-5 + ward slot 6)
        const itemIds = [player.item0, player.item1, player.item2, player.item3, player.item4, player.item5].filter(id => id > 0);
        const items = itemIds.map(id => enrichItem(id, dd));
        
        games.push({
          id: match.metadata.matchId,
          gameCreation: match.info.gameCreation,
          date: new Date(match.info.gameCreation).toLocaleDateString('fr-FR'),
          duration: Math.round(match.info.gameDuration / 60),
          
          // Joueur
          champion: enrichChampion(player.championId, dd),
          championName: player.championName,
          role: player.teamPosition || player.individualPosition,
          win: player.win,
          kills: player.kills,
          deaths: player.deaths,
          assists: player.assists,
          kda: player.deaths === 0 ? 'Perfect' : ((player.kills + player.assists) / player.deaths).toFixed(2),
          cs: player.totalMinionsKilled + player.neutralMinionsKilled,
          csPerMin: ((player.totalMinionsKilled + player.neutralMinionsKilled) / (match.info.gameDuration / 60)).toFixed(1),
          vision: player.visionScore,
          wardsPlaced: player.wardsPlaced,
          wardsKilled: player.wardsKilled,
          damageDealt: player.totalDamageDealtToChampions,
          damageTaken: player.totalDamageTaken,
          goldEarned: player.goldEarned,
          items,
          
          // Équipes
          enemyTeam: enemies.map(e => ({
            champion: enrichChampion(e.championId, dd),
            championName: e.championName,
            kills: e.kills,
            deaths: e.deaths,
            assists: e.assists,
            items: [e.item0, e.item1, e.item2, e.item3, e.item4, e.item5].filter(id => id > 0).map(id => enrichItem(id, dd)),
          })),
          allyTeam: allies.map(a => ({
            champion: enrichChampion(a.championId, dd),
            championName: a.championName,
            kills: a.kills,
            deaths: a.deaths,
            assists: a.assists,
          })),
        });
      }
    }
    
    res.json({ puuid, count: games.length, games });
  } catch (err) {
    handleError(res, err);
  }
});

// ── 3. Timeline d'une game (timing des achats d'items) ──
// GET /api/timeline/:matchId/:puuid
app.get('/api/timeline/:matchId/:puuid', async (req, res) => {
  try {
    const { matchId, puuid } = req.params;
    const dd = await getDataDragon();
    
    const timeline = await riotFetch(
      `${RIOT_ROUTING_BASE}/lol/match/v5/matches/${matchId}/timeline`
    );
    
    // Trouver le participantId du joueur
    const participant = timeline.info.participants.find(p => p.puuid === puuid);
    if (!participant) throw { status: 404, message: 'Joueur non trouvé dans cette game' };
    const pid = participant.participantId;
    
    // Extraire les achats d'items
    const purchases = [];
    for (const frame of timeline.info.frames) {
      for (const event of frame.events) {
        if (event.type === 'ITEM_PURCHASED' && event.participantId === pid) {
          purchases.push({
            minute: Math.round(event.timestamp / 60000),
            timestamp: event.timestamp,
            item: enrichItem(event.itemId, dd),
          });
        }
      }
    }
    
    // Extraire les kills/deaths avec positions
    const killEvents = [];
    for (const frame of timeline.info.frames) {
      for (const event of frame.events) {
        if (event.type === 'CHAMPION_KILL') {
          if (event.killerId === pid || event.victimId === pid) {
            killEvents.push({
              minute: Math.round(event.timestamp / 60000),
              isKill: event.killerId === pid,
              isDeath: event.victimId === pid,
              position: event.position,
            });
          }
        }
      }
    }
    
    res.json({ matchId, participantId: pid, purchases, killEvents });
  } catch (err) {
    handleError(res, err);
  }
});

// ══════════════════════════════════════════════════
// ROUTES — LOLALYTICS
// ══════════════════════════════════════════════════

// ── 4. Données d'un champion (build général) ──
// GET /api/lolalytics/champion/:champion?tier=platinum_plus&patch=current
app.get('/api/lolalytics/champion/:champion', async (req, res) => {
  try {
    const { champion } = req.params;
    const tier = req.query.tier || 'platinum_plus';
    const patch = req.query.patch || 'current';
    
    const data = await lolaltyicsFetch(
      `ep=champion&p=d&v=1&patch=${patch}&c=${champion.toLowerCase()}&tier=${tier}&queue=420&region=all`
    );
    
    const dd = await getDataDragon();
    
    // Enrichir les items avec noms et images
    if (data.header?.n) {
      data._enriched = {
        champion: champion,
        gamesAnalyzed: data.header.n,
      };
    }
    
    res.json(data);
  } catch (err) {
    handleError(res, err);
  }
});

// ── 5. Données d'un matchup spécifique ──
// GET /api/lolalytics/matchup/:champion/:vsChampion
app.get('/api/lolalytics/matchup/:champion/:vsChampion', async (req, res) => {
  try {
    const { champion, vsChampion } = req.params;
    const tier = req.query.tier || 'platinum_plus';
    
    const data = await lolaltyicsFetch(
      `ep=champion&p=d&v=1&patch=current&c=${champion.toLowerCase()}&tier=${tier}&queue=420&region=all&vs=${vsChampion.toLowerCase()}`
    );
    
    res.json(data);
  } catch (err) {
    handleError(res, err);
  }
});

// ══════════════════════════════════════════════════
// ROUTES — DATA DRAGON (images, noms)
// ══════════════════════════════════════════════════

// ── 6. Infos d'un item par ID ──
app.get('/api/item/:itemId', async (req, res) => {
  try {
    const dd = await getDataDragon();
    const item = enrichItem(req.params.itemId, dd);
    res.json(item);
  } catch (err) {
    handleError(res, err);
  }
});

// ── 7. Infos d'un champion par ID ──
app.get('/api/champion/:championId', async (req, res) => {
  try {
    const dd = await getDataDragon();
    const champ = enrichChampion(req.params.championId, dd);
    res.json(champ);
  } catch (err) {
    handleError(res, err);
  }
});

// ── 8. Liste complète des champions ──
app.get('/api/champions', async (req, res) => {
  try {
    const dd = await getDataDragon();
    const champions = Object.values(dd.champions).map(c => ({
      id: c.key,
      name: c.name,
      title: c.title,
      tags: c.tags,
      image: `https://ddragon.leagueoflegends.com/cdn/${dd.version}/img/champion/${c.image.full}`,
    }));
    res.json({ version: dd.version, champions });
  } catch (err) {
    handleError(res, err);
  }
});

// ══════════════════════════════════════════════════
// HEALTH CHECK
// ══════════════════════════════════════════════════

app.get('/api/debug', async (req, res) => {
  const results = {
    keyLength: RIOT_KEY ? RIOT_KEY.length : 0,
    keyPrefix: RIOT_KEY ? RIOT_KEY.substring(0, 15) : 'MISSING',
    keyHasDoubleRGAPI: RIOT_KEY ? RIOT_KEY.includes('RGAPI-RGAPI') : false,
    keyHasSpaces: RIOT_KEY ? RIOT_KEY !== RIOT_KEY.trim() : false,
    platformUrl: RIOT_BASE,
    routingUrl: RIOT_ROUTING_BASE,
    tests: {}
  };
  try {
    const r1 = await fetch(`${RIOT_BASE}/lol/status/v4/platform-data`, { headers: { 'X-Riot-Token': RIOT_KEY } });
    results.tests.platform = { status: r1.status, ok: r1.ok };
  } catch (e) { results.tests.platform = { error: e.message }; }
  try {
    const r2 = await fetch(`${RIOT_ROUTING_BASE}/riot/account/v1/accounts/by-riot-id/Faker/KR1`, { headers: { 'X-Riot-Token': RIOT_KEY } });
    const body = await r2.text();
    results.tests.routing = { status: r2.status, body: body.substring(0, 200) };
  } catch (e) { results.tests.routing = { error: e.message }; }
  res.json(results);
});

app.get('/api/health', async (req, res) => {
  const hasKey = !!RIOT_KEY && RIOT_KEY !== 'RGAPI-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx';
  let riotOk = false;
  
  if (hasKey) {
    try {
      await riotFetch(`${RIOT_BASE}/lol/status/v4/platform-data`);
      riotOk = true;
    } catch {}
  }
  
  res.json({
    status: 'ok',
    region: REGION,
    routing: ROUTING,
    riotKeyConfigured: hasKey,
    riotApiConnected: riotOk,
    timestamp: new Date().toISOString(),
  });
});

// ══════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║         🎮 LoL Coach Pro — Backend API       ║
╠══════════════════════════════════════════════╣
║  Port:     ${PORT}                              ║
║  Region:   ${REGION}                            ║
║  Routing:  ${ROUTING}                          ║
║  Riot Key: ${RIOT_KEY ? '✅ configurée' : '❌ MANQUANTE'}                    ║
╠══════════════════════════════════════════════╣
║  Routes:                                     ║
║  GET /api/summoner/:name/:tag                ║
║  GET /api/matches/:puuid                     ║
║  GET /api/timeline/:matchId/:puuid           ║
║  GET /api/lolalytics/champion/:champ         ║
║  GET /api/lolalytics/matchup/:champ/:vs      ║
║  GET /api/champions                          ║
║  GET /api/health                             ║
╚══════════════════════════════════════════════╝
  `);
});
