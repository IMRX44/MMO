// HUD + panels. Renders server-sent self/inventory state; sends intents back.
import {
  CLASSES, QUESTS, DUNGEONS, RARITIES, skillUpgradeCost, MAX_SKILL_LEVEL, EQUIP_SLOTS,
  RECIPES, MAT_NAMES, MAT_ICONS, MOUNTS, GATHER, CHESTS, profLevel, DAILY_QUESTS,
  TALENTS, SEASON,
} from '/shared/constants.js';
import { biomeAt, TILE, inTown } from '/shared/worldgen.js';
import { SKILL_ICONS, CLASS_ICONS } from './models.js';
import { sfx, setZone, zoneKeyFor, setSfxVolume, setMusicVolume, getSfxVolume, getMusicVolume } from './audio.js';

const $ = id => document.getElementById(id);

export class UI {
  constructor(net) {
    this.net = net;
    this.charInfo = null;
    this.skills = [];
    this.self = null;
    this.inv = null;
    this.lastZone = '';

    net.on('self', s => this.onSelf(s));
    net.on('inv', i => this.onInv(i));
    net.on('chat', c => this.chatLine(c));
    net.on('loot', l => this.onLoot(l));
    net.on('partyInvite', p => this.onPartyInvite(p));
    net.on('partyState', p => this.onPartyState(p));
    net.on('tradeInvite', t => this.onTradeInvite(t));
    net.on('tradeState', t => this.onTradeState(t));
    net.on('tradeDone', t => this.onTradeDone(t));
    net.on('guildState', g => { this.guild = g; this.renderGuild(); });
    net.on('guildInvite', g => this.onGuildInvite(g));
    net.on('marketState', m => { this.market = m; this.renderMarket(); });

    // panels
    document.querySelectorAll('#menu-buttons button').forEach(btn => {
      btn.addEventListener('click', () => this.togglePanel(btn.dataset.panel));
    });
    document.querySelectorAll('.panel-close').forEach(btn => {
      btn.addEventListener('click', () => btn.closest('.panel').classList.add('hidden'));
    });
    window.addEventListener('keydown', e => {
      if (document.activeElement?.tagName === 'INPUT') return;
      if (e.code === 'KeyC') this.togglePanel('panel-char');
      if (e.code === 'KeyB') this.togglePanel('panel-inv');
      if (e.code === 'KeyK') this.togglePanel('panel-skills');
      if (e.code === 'KeyJ') this.togglePanel('panel-quests');
      if (e.code === 'KeyV') this.togglePanel('panel-craft');
      if (e.code === 'KeyG') this.togglePanel('panel-guild');
      if (e.code === 'KeyP') this.togglePanel('panel-market');
      if (e.code === 'KeyT') this.togglePanel('panel-talents');
    });

    // settings sliders
    const vm = $('vol-music'), vs = $('vol-sfx');
    vm.value = getMusicVolume(); vs.value = getSfxVolume();
    vm.addEventListener('input', () => setMusicVolume(+vm.value));
    vs.addEventListener('input', () => { setSfxVolume(+vs.value); sfx.ui(); });
    window.addEventListener('keydown', e => {
      if (document.activeElement?.tagName === 'INPUT') return;
      if (e.code === 'KeyO') this.togglePanel('panel-settings');
    });

    this.craftGroup = 'refine';
    document.querySelectorAll('.ctab').forEach(btn => {
      btn.addEventListener('click', () => {
        this.craftGroup = btn.dataset.group;
        document.querySelectorAll('.ctab').forEach(b => b.classList.toggle('active', b === btn));
        this.renderCraft();
      });
    });

    // chat
    const input = $('chat-input');
    window.addEventListener('keydown', e => {
      if (e.code === 'Enter' && document.activeElement !== input) { input.focus(); e.preventDefault(); }
    });
    input.addEventListener('keydown', e => {
      if (e.code === 'Enter') {
        const text = input.value.trim();
        input.value = '';
        input.blur();
        if (!text) return;
        if (text.startsWith('/invite ')) this.net.emit('party', { action: 'invite', name: text.slice(8).trim() });
        else if (text.startsWith('/trade ')) this.net.emit('trade', { action: 'invite', name: text.slice(7).trim() });
        else if (text === '/arena') this.net.emit('arena', { action: this.inQueue ? 'leave' : 'queue' }), this.inQueue = !this.inQueue;
        else if (text === '/leave') this.net.emit('party', { action: 'leave' });
        else this.net.emit('chat', { text });
      }
      if (e.code === 'Escape') input.blur();
      e.stopPropagation();
    });

    // potions
    document.querySelectorAll('.pslot').forEach(el => {
      el.addEventListener('click', () => this.net.emit('potion', { kind: el.dataset.potion }));
    });
    $('btn-buy-hp').addEventListener('click', () => this.net.emit('buyPotion', { kind: 'hpPotion', qty: 1 }));
    $('btn-buy-mp').addEventListener('click', () => this.net.emit('buyPotion', { kind: 'mpPotion', qty: 1 }));

    this.tooltip = $('tooltip');
    document.addEventListener('mousemove', e => {
      this.tooltip.style.left = Math.min(e.clientX + 14, window.innerWidth - 270) + 'px';
      this.tooltip.style.top = Math.min(e.clientY + 14, window.innerHeight - 200) + 'px';
    });
  }

  startGame(charInfo, onCast) {
    this.charInfo = charInfo;
    this.onCast = onCast;
    this.skills = CLASSES[charInfo.class].skills;
    $('hud-name').textContent = charInfo.name;
    this.buildHotbar();
  }

  togglePanel(id) {
    const el = $(id);
    const wasHidden = el.classList.contains('hidden');
    this.closePanels();
    if (wasHidden) {
      el.classList.remove('hidden');
      if (id === 'panel-char') this.renderCharSheet();
      if (id === 'panel-inv') this.renderInventory();
      if (id === 'panel-skills') this.renderSkills();
      if (id === 'panel-quests') this.renderQuests();
      if (id === 'panel-craft') this.renderCraft();
      if (id === 'panel-guild') { this.net.emit('guild', { action: 'info' }); this.renderGuild(); }
      if (id === 'panel-talents') this.renderTalents();
      if (id === 'panel-market') { this.marketSellMode = false; this.net.emit('market', { action: 'list' }); }
    }
  }
  closePanels() { document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden')); }

  // --- hotbar -----------------------------------------------------------------
  buildHotbar() {
    const bar = $('hotbar');
    bar.innerHTML = '';
    this.slotEls = [];
    this.skills.forEach((sk, i) => {
      const el = document.createElement('div');
      el.className = 'slot';
      el.innerHTML = `<span class="key">${i + 1}</span>${SKILL_ICONS[sk.id] || '❓'}` +
        (sk.mp ? `<span class="mpcost">${sk.mp}</span>` : '') +
        `<div class="cd hidden"></div>`;
      el.addEventListener('click', () => this.onCast?.(i));
      el.addEventListener('mouseenter', () => this.showSkillTooltip(sk));
      el.addEventListener('mouseleave', () => this.hideTooltip());
      bar.appendChild(el);
      this.slotEls.push(el);
    });
  }

  showSkillTooltip(sk) {
    const lvl = this.inv?.skillLevels?.[sk.id] || 1;
    this.tooltip.innerHTML = `
      <div class="tt-name">${SKILL_ICONS[sk.id] || ''} ${sk.name} <span class="tt-muted">Lv ${lvl}</span></div>
      <div class="tt-muted">${sk.kind} · ${sk.mp ? sk.mp + ' MP · ' : ''}${sk.cd}s CD${sk.range ? ' · ' + Math.abs(sk.range) + 'm' : ''}${sk.radius ? ' · r' + sk.radius : ''}</div>
      ${sk.unlock > (this.self?.level ?? 1) ? `<div style="color:#ff7675">Unlocks at level ${sk.unlock}</div>` : ''}`;
    this.tooltip.classList.remove('hidden');
  }
  hideTooltip() { this.tooltip.classList.add('hidden'); }

  flashSlot(i) {
    this.slotEls?.[i]?.classList.add('on-gcd');
    setTimeout(() => this.slotEls?.[i]?.classList.remove('on-gcd'), 150);
  }

  // --- server self state --------------------------------------------------------
  onSelf(s) {
    this.self = s;
    $('hud-level').textContent = 'Lv ' + s.level;
    this.setBar('bar-hp', 'txt-hp', s.hp, s.maxHp);
    this.setBar('bar-mp', 'txt-mp', s.mp, s.maxMp);
    this.setBar('bar-xp', 'txt-xp', s.xp, s.xpNext, true);
    $('bar-stamina').style.width = Math.max(0, (s.stamina / s.maxStamina) * 100) + '%';
    $('txt-gold').textContent = s.gold.toLocaleString();
    $('txt-tokens').textContent = s.tokens ?? 0;
    $('txt-shards').textContent = s.shards ?? 0;

    // cooldown overlays
    if (this.slotEls) {
      this.skills.forEach((sk, i) => {
        const el = this.slotEls[i];
        const cdEl = el.querySelector('.cd');
        const locked = s.level < sk.unlock;
        el.classList.toggle('locked', locked);
        const cd = s.cooldowns[sk.id];
        if (cd && cd > 0.05) { cdEl.classList.remove('hidden'); cdEl.textContent = cd.toFixed(cd < 3 ? 1 : 0); }
        else cdEl.classList.add('hidden');
      });
    }

    // death overlay
    if (s.dead) {
      $('death-overlay').classList.remove('hidden');
      $('respawn-timer').textContent = Math.ceil(s.respawnIn);
    } else {
      $('death-overlay').classList.add('hidden');
    }

    // refresh open panels that show numbers
    if (!$('panel-char').classList.contains('hidden')) this.renderCharSheet();
  }

  setBar(barId, txtId, val, max, short) {
    $(barId).style.width = Math.max(0, Math.min(100, (val / max) * 100)) + '%';
    $(txtId).textContent = short ? `${Math.floor((val / max) * 100)}%` : `${val} / ${max}`;
  }

  onInv(inv) {
    this.inv = inv;
    $('cnt-hp').textContent = inv.potions.hpPotion || 0;
    $('cnt-mp').textContent = inv.potions.mpPotion || 0;
    // quest tracker
    const q = inv.quests.active ? QUESTS.find(x => x.id === inv.quests.active) : null;
    if (q) {
      $('hud-quest').classList.remove('hidden');
      $('quest-name').textContent = '❗ ' + q.name;
      $('quest-prog').textContent = `${q.mob ? 'Kill' : 'Slay'} ${q.count} — ${inv.quests.progress}/${q.count}`;
    } else {
      $('hud-quest').classList.add('hidden');
    }
    if (!$('panel-inv').classList.contains('hidden')) this.renderInventory();
    if (!$('panel-skills').classList.contains('hidden')) this.renderSkills();
    if (!$('panel-quests').classList.contains('hidden')) this.renderQuests();
    if (!$('panel-craft').classList.contains('hidden')) this.renderCraft();
    if (!$('panel-talents').classList.contains('hidden')) this.renderTalents();
  }

  onGathered(e) {
    const kind = e.mat.replace(/\d+$/, '');
    const tier = e.mat.match(/\d+$/)?.[0] || '';
    this.announce(`+${e.qty} ${MAT_ICONS[kind] || ''} T${tier} ${MAT_NAMES[kind] || kind}`, '#c9e265');
    sfx.gatherDone();
  }

  matChip(key, qty) {
    const kind = key.replace(/\d+$/, '');
    const tier = key.match(/\d+$/)?.[0] || '';
    return `<span class="mat-chip" title="T${tier} ${MAT_NAMES[kind]}">${MAT_ICONS[kind] || '❔'}<b>T${tier}</b> ${qty}</span>`;
  }

  renderCraft() {
    const list = $('craft-list');
    if (!list || !this.inv) return;
    const mats = this.inv.materials || {};
    const gold = this.inv.gold ?? 0;
    list.innerHTML = '';
    // profession levels strip
    const profs = this.inv.professions || {};
    const profHtml = ['wood', 'stone', 'ore', 'fiber', 'hide'].map(k => {
      const lvl = profLevel(profs[k] || 0);
      return `<span class="mat-chip" title="${k} profession">${MAT_ICONS[k]} Lv ${lvl}</span>`;
    }).join('');
    const profDiv = document.createElement('div');
    profDiv.style.marginBottom = '8px';
    profDiv.innerHTML = profHtml + `<div class="tt-muted" style="font-size:11px;margin-top:4px">T3 needs Lv20 · T4 Lv40 · T5 Lv60 — gather to skill up</div>`;
    list.appendChild(profDiv);
    for (const r of RECIPES.filter(r => r.group === this.craftGroup)) {
      if (r.group === 'mount' && this.inv.mounts?.includes(r.out.mount)) continue;
      let craftable = true;
      const costHtml = Object.entries(r.cost).map(([k, need]) => {
        const have = k === 'gold' ? gold : (mats[k] || 0);
        if (have < need) craftable = false;
        const kind = k === 'gold' ? 'gold' : k.replace(/\d+$/, '');
        const icon = k === 'gold' ? '🪙' : (MAT_ICONS[kind] || '');
        return `<span class="${have >= need ? 'cost-ok' : 'cost-no'}">${icon}${have}/${need}</span>`;
      }).join(' ');
      const row = document.createElement('div');
      row.className = 'craft-row';
      row.innerHTML = `
        <div class="cr-icon">${r.icon}</div>
        <div class="cr-body">
          <div class="cr-name">${r.name}</div>
          <div class="cr-cost">${costHtml}</div>
        </div>
        <button class="btn-small cr-go" data-id="${r.id}" ${craftable ? '' : 'disabled'}>Craft</button>`;
      list.appendChild(row);
    }
    if (!list.children.length) list.innerHTML = '<div class="tt-muted" style="padding:12px">Nothing to craft here yet.</div>';
    list.querySelectorAll('.cr-go').forEach(b =>
      b.addEventListener('click', () => this.net.emit('craft', { recipeId: b.dataset.id })));
  }

  onLoot(l) {
    const r = RARITIES[l.item.rarity];
    this.chatLine({ from: 'Loot', text: `${l.item.name} [${r.name}]`, channel: 'system' });
    this.announce(`+ ${l.item.name}`, r.color);
    sfx.loot(l.item.rarity);
  }

  // --- panels -----------------------------------------------------------------------
  renderCharSheet() {
    const s = this.self, inv = this.inv;
    if (!s || !inv) return;
    const d = s.derived;
    const rows = Object.entries(d.stats).map(([k, v]) => `
      <div class="stat-row">
        <span>${k.toUpperCase()}</span>
        <span>${Math.floor(v)}
          ${s.unspent > 0 ? `<button class="plus" data-stat="${k}">+</button>` : ''}
        </span>
      </div>`).join('');
    $('char-sheet').innerHTML = `
      <div class="stat-row"><b>${this.charInfo.name}</b><span class="lvl">Lv ${s.level} ${CLASSES[this.charInfo.class].name}</span></div>
      ${s.unspent > 0 ? `<div class="unspent">✦ ${s.unspent} unspent points</div>` : ''}
      ${rows}
      <div class="derived-box">
        Attack ${d.attack} · Spell ${d.spell}<br>
        Crit ${d.critPct}% · Haste ${d.hastePct}%<br>
        Armor ${d.armor} ${s.shield ? '· Shield ' + s.shield : ''}
      </div>
      <button class="btn-small" id="btn-respec" style="margin-top:10px">Respec (${50 * s.level}g)</button>`;
    $('char-sheet').querySelectorAll('.plus').forEach(b =>
      b.addEventListener('click', () => this.net.emit('allocate', { stat: b.dataset.stat })));
    $('btn-respec')?.addEventListener('click', () => this.net.emit('respec'));
  }

  renderInventory() {
    const inv = this.inv;
    if (!inv) return;
    const strip = $('mat-strip');
    const mats = Object.entries(inv.materials || {}).filter(([, q]) => q > 0)
      .sort((a, b) => a[0].localeCompare(b[0]));
    strip.innerHTML = mats.length
      ? mats.map(([k, q]) => this.matChip(k, q)).join('')
      : '<span class="tt-muted" style="font-size:12px">Gather resources with [F] near trees, rocks, ore veins and plants…</span>';
    if (inv.mounts?.length) {
      strip.innerHTML += '<div style="margin-top:6px">' + inv.mounts.map(m =>
        `<span class="mat-chip ${inv.activeMount === m ? 'mat-active' : ''}" data-mount="${m}">🐴 ${MOUNTS[m]?.name || m}</span>`).join('') +
        ' <span class="tt-muted" style="font-size:11px">[Z] to ride</span></div>';
      strip.querySelectorAll('[data-mount]').forEach(el =>
        el.addEventListener('click', () => this.net.emit('mount', { id: el.dataset.mount })));
    }
    const eq = $('equip-grid');
    eq.innerHTML = '';
    for (const slot of EQUIP_SLOTS) {
      const item = inv.equipment[slot];
      const el = document.createElement('div');
      el.className = 'islot';
      el.dataset.rarity = item?.rarity || '';
      el.innerHTML = (item ? this.itemIcon(item) : '') + `<span class="sl-label">${slot}</span>`;
      if (item) {
        el.addEventListener('click', e => {
          if (e.ctrlKey || e.metaKey) this.net.emit('enchant', { itemId: item.id });
          else this.net.emit('unequip', { slot });
        });
        el.addEventListener('mouseenter', () => this.showItemTooltip(item, 'Click unequip · Ctrl enchant'));
        el.addEventListener('mouseleave', () => this.hideTooltip());
      }
      eq.appendChild(el);
    }
    const grid = $('inv-grid');
    grid.innerHTML = '';
    for (const item of inv.inventory) {
      const el = document.createElement('div');
      const eq = inv.equipment[item.slot];
      const better = this.itemScore(item) > this.itemScore(eq);
      el.className = 'islot' + (better ? ' better' : '');
      el.dataset.rarity = item.rarity;
      el.innerHTML = this.itemIcon(item);
      el.addEventListener('click', e => {
        if (this.tradeActive) this.net.emit('trade', { action: 'add', itemId: item.id });
        else if (e.shiftKey) this.net.emit('sellItem', { itemId: item.id });
        else if (e.ctrlKey || e.metaKey) this.net.emit('enchant', { itemId: item.id });
        else if (e.altKey) this.net.emit('salvage', { itemId: item.id });
        else this.net.emit('equip', { itemId: item.id });
      });
      el.addEventListener('mouseenter', () => this.showItemTooltip(item, 'Click equip · Shift sell · Ctrl enchant · Alt salvage'));
      el.addEventListener('mouseleave', () => this.hideTooltip());
      grid.appendChild(el);
    }
    for (let i = inv.inventory.length; i < 24; i++) {
      const el = document.createElement('div');
      el.className = 'islot';
      grid.appendChild(el);
    }
  }

  itemIcon(item) {
    return { weapon: '🗡️', head: '🪖', chest: '🥋', legs: '👖', boots: '🥾', ring: '💍', amulet: '📿' }[item.slot] || '❔';
  }

  itemScore(item) {
    if (!item) return 0;
    const s = Object.values(item.stats || {}).reduce((a, b) => a + b, 0);
    return (item.attack || 0) + (item.spell || 0) + (item.armor || 0) * 1.2 + (item.hp || 0) * 0.25 + s * 1.5;
  }

  showItemTooltip(item, hint) {
    const r = RARITIES[item.rarity];
    const stats = Object.entries(item.stats || {}).map(([k, v]) => `+${v} ${k.toUpperCase()}`).join(' · ');
    // compare with what's equipped in the same slot
    const eq = this.inv?.equipment?.[item.slot];
    let compare = '';
    if (eq && eq.id !== item.id) {
      const diff = this.itemScore(item) - this.itemScore(eq);
      compare = `<div class="${diff >= 0 ? 'tt-diff-up' : 'tt-diff-down'}">${diff >= 0 ? '▲' : '▼'} ${diff >= 0 ? '+' : ''}${Math.round(diff)} vs equipped (${eq.name})</div>`;
    }
    const ench = item.enchant ? ` +${item.enchant}` : '';
    this.tooltip.innerHTML = `
      <div class="tt-name" style="color:${r.color}">${item.name}${ench ? `<span style="color:#c084fc">${ench}</span>` : ''}</div>
      <div class="tt-muted">${r.name} ${item.slot} · item level ${item.level}${item.crafted ? ' · crafted' : ''}${item.enchant ? ` · enchant +${item.enchant}/10 (+${item.enchant * 4}%)` : ''}</div>
      ${item.attack ? `Attack +${item.attack}<br>` : ''}${item.spell ? `Spell +${item.spell}<br>` : ''}
      ${item.armor ? `Armor +${item.armor}<br>` : ''}${item.hp ? `HP +${item.hp}<br>` : ''}
      ${stats ? `<div>${stats}</div>` : ''}
      ${item.flavor ? `<div class="tt-muted"><i>${item.flavor}</i></div>` : ''}
      ${compare}
      <div class="tt-muted">Sell: ${item.sellValue}g · ${hint}</div>`;
    this.tooltip.classList.remove('hidden');
  }

  renderSkills() {
    const list = $('skill-list');
    const lvls = this.inv?.skillLevels || {};
    list.innerHTML = '';
    for (const sk of this.skills) {
      const cur = lvls[sk.id] || 1;
      const locked = (this.self?.level ?? 1) < sk.unlock;
      const cost = skillUpgradeCost(cur);
      const row = document.createElement('div');
      row.className = 'skill-row' + (locked ? ' locked' : '');
      row.innerHTML = `
        <div class="sk-icon">${SKILL_ICONS[sk.id] || '❓'}</div>
        <div class="sk-body">
          <div class="sk-name">${sk.name} <span class="tt-muted">Lv ${cur}${cur >= MAX_SKILL_LEVEL ? ' (MAX)' : ''}</span></div>
          <div class="sk-meta">${locked ? `Unlocks at level ${sk.unlock}` : `${sk.mp} MP · ${sk.cd}s CD · +${(cur - 1) * 8}% power`}</div>
        </div>
        ${!locked && cur < MAX_SKILL_LEVEL ? `<button class="btn-small sk-up" data-id="${sk.id}">⬆ ${cost}g</button>` : ''}`;
      list.appendChild(row);
    }
    list.querySelectorAll('.sk-up').forEach(b =>
      b.addEventListener('click', () => this.net.emit('upgradeSkill', { skillId: b.dataset.id })));
  }

  questGoal(quest) {
    if (quest.mob) return `Kill ${quest.count} × ${quest.mob}`;
    if (quest.boss) return 'Slay the boss';
    if (quest.mat) {
      const kind = quest.mat.replace(/\d+$/, '');
      return `Deliver ${quest.count} × ${MAT_ICONS[kind] || ''} ${MAT_NAMES[kind]}`;
    }
    if (quest.craft) return `Craft ${quest.count} × ${quest.craft === 'any' ? 'anything' : quest.craft}`;
    return '';
  }

  renderQuests() {
    const list = $('quest-list');
    const q = this.inv?.quests;
    if (!q) return;
    list.innerHTML = '';

    // season pass
    const season = this.inv.season;
    if (season) {
      const need = SEASON.xpForLevel(season.level + 1);
      let intoLevel = season.xp;
      for (let l = 1; l <= season.level; l++) intoLevel -= SEASON.xpForLevel(l);
      const claimable = season.level - season.claimed.length;
      const head = document.createElement('div');
      head.className = 'quest-row';
      head.innerHTML = `
        <div class="q-name" style="color:var(--xp)">🎫 ${SEASON.name}</div>
        <div class="q-meta">Level ${season.level}/${SEASON.maxLevel} · ${Math.min(intoLevel, need)}/${need} XP
          — next: ${SEASON.reward(Math.min(SEASON.maxLevel, season.level + 1)).label}</div>
        <div class="bar xp" style="margin-top:4px"><div class="fill" style="width:${Math.min(100, intoLevel / need * 100)}%"></div></div>
        ${claimable > 0 ? `<button class="btn-small" id="season-claim" style="margin-top:6px">🎁 Claim ${claimable} reward${claimable > 1 ? 's' : ''}!</button>` : ''}`;
      list.appendChild(head);
      head.querySelector('#season-claim')?.addEventListener('click', () => this.net.emit('claimSeason'));
    }

    // dailies
    const daily = this.inv.daily;
    if (daily) {
      const head = document.createElement('div');
      head.className = 'q-name';
      head.style.color = 'var(--gold)';
      head.textContent = '📅 Daily Quests';
      list.appendChild(head);
      for (const dq of DAILY_QUESTS) {
        const have = daily[dq.kind] || 0;
        const claimed = daily.claimed?.includes(dq.id);
        const done = have >= dq.count;
        const row = document.createElement('div');
        row.className = 'quest-row';
        row.innerHTML = `
          <div class="q-name">${dq.icon} ${dq.name} ${claimed ? '✅' : ''}</div>
          <div class="q-meta">${Math.min(have, dq.count)}/${dq.count} — ${dq.reward.gold}g + ${dq.reward.tokens} 🏅</div>
          ${done && !claimed ? `<button class="btn-small dq-claim" data-id="${dq.id}">Claim!</button>` : ''}`;
        list.appendChild(row);
      }
      list.querySelectorAll('.dq-claim').forEach(b =>
        b.addEventListener('click', () => this.net.emit('claimDaily', { id: b.dataset.id })));
    }

    const head2 = document.createElement('div');
    head2.className = 'q-name';
    head2.style.cssText = 'color:var(--gold);margin-top:10px';
    head2.textContent = '📜 Story Quests';
    list.appendChild(head2);
    for (const quest of QUESTS) {
      const done = q.completed.includes(quest.id);
      const active = q.active === quest.id;
      const available = !done && !active && (!quest.requires || q.completed.includes(quest.requires)) && (this.self?.level ?? 1) >= quest.minLevel;
      if (!done && !active && !available) continue;
      const row = document.createElement('div');
      row.className = 'quest-row';
      let turnIn = '';
      if (active && quest.mat) {
        const have = this.inv.materials?.[quest.mat] || 0;
        turnIn = have >= quest.count
          ? `<button class="btn-small q-turnin">Turn in!</button>`
          : `<div class="q-done">${have}/${quest.count} gathered</div>`;
      }
      row.innerHTML = `
        <div class="q-name">${done ? '✅' : active ? '⏳' : '❗'} ${quest.name}</div>
        <div class="q-meta">${this.questGoal(quest)} — ${quest.reward.xp} XP, ${quest.reward.gold}g</div>
        ${active && !quest.mat ? `<div class="q-done">${q.progress}/${quest.count}</div>` : ''}
        ${turnIn}
        ${available ? `<button class="btn-small q-accept" data-id="${quest.id}">Accept</button>` : ''}`;
      list.appendChild(row);
    }
    list.querySelectorAll('.q-accept').forEach(b =>
      b.addEventListener('click', () => this.net.emit('acceptQuest', { questId: b.dataset.id })));
    list.querySelector('.q-turnin')?.addEventListener('click', () => this.net.emit('turnInQuest'));
  }

  // --- target / party -----------------------------------------------------------------
  updateTarget(data) {
    const f = $('hud-target');
    if (!data) { f.classList.add('hidden'); return; }
    f.classList.remove('hidden');
    $('tgt-name').textContent = data.name;
    $('tgt-level').textContent = 'Lv ' + data.level;
    $('tgt-hp').style.width = Math.max(0, (data.hp / data.maxHp) * 100) + '%';
    $('tgt-hp-txt').textContent = `${data.hp} / ${data.maxHp}`;
  }

  onPartyInvite(p) {
    const toast = $('party-toast');
    toast.classList.remove('hidden');
    toast.innerHTML = `<b>${p.from}</b> invited you to a party.<br>
      <button class="btn-primary" id="pt-accept">Accept</button>
      <button class="btn-small" id="pt-decline">Decline</button>`;
    $('pt-accept').addEventListener('click', () => { this.net.emit('party', { action: 'accept' }); toast.classList.add('hidden'); });
    $('pt-decline').addEventListener('click', () => toast.classList.add('hidden'));
    setTimeout(() => toast.classList.add('hidden'), 30000);
  }

  onPartyState(p) {
    this.partyMembers = p.members;
    const el = $('hud-party');
    if (!p.members.length) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.innerHTML = p.members.map(m => `
      <div class="pm" data-id="${m.id}">
        <div class="pm-name">${CLASS_ICONS[m.class] || ''} ${m.name} <span class="lvl">${m.level}</span></div>
        <div class="bar hp"><div class="fill" style="width:${(m.hp / m.maxHp) * 100}%"></div></div>
      </div>`).join('');
  }

  updatePartyBars(players) {
    if (!this.partyMembers?.length) return;
    for (const m of this.partyMembers) {
      const snap = players.find(p => p.id === m.id);
      if (!snap) continue;
      const el = document.querySelector(`.pm[data-id="${m.id}"] .fill`);
      if (el) el.style.width = Math.max(0, (snap.hp / snap.maxHp) * 100) + '%';
    }
  }

  // --- trade -------------------------------------------------------------------
  onTradeInvite(t) {
    const toast = $('trade-toast');
    toast.classList.remove('hidden');
    toast.innerHTML = `<b>${t.from}</b> wants to trade.<br>
      <button class="btn-primary" id="tr-accept">Trade</button>
      <button class="btn-small" id="tr-decline">Decline</button>`;
    $('tr-accept').addEventListener('click', () => { this.net.emit('trade', { action: 'accept' }); toast.classList.add('hidden'); });
    $('tr-decline').addEventListener('click', () => toast.classList.add('hidden'));
    setTimeout(() => toast.classList.add('hidden'), 25000);
  }

  onTradeState(t) {
    this.tradeActive = true;
    const panel = $('panel-trade');
    if (panel.classList.contains('hidden')) {
      panel.classList.remove('hidden');
      $('panel-inv').classList.remove('hidden');
      this.renderInventory();
      $('trade-cancel').onclick = () => this.net.emit('trade', { action: 'cancel' });
      $('trade-confirm').onclick = () => this.net.emit('trade', { action: 'confirm' });
      $('trade-gold-input').onchange = e => this.net.emit('trade', { action: 'gold', amount: +e.target.value });
    }
    $('trade-partner').textContent = t.partner;
    $('trade-my-confirm').innerHTML = t.confirmed.mine ? '<span class="confirm-yes">✔ ready</span>' : '';
    $('trade-their-confirm').innerHTML = t.confirmed.theirs ? '<span class="confirm-yes">✔ ready</span>' : '';
    $('trade-their-gold').textContent = t.theirs.gold;
    const render = (elId, items, mine) => {
      const el = $(elId);
      el.innerHTML = '';
      for (const item of items) {
        const d = document.createElement('div');
        d.className = 'islot';
        d.dataset.rarity = item.rarity;
        d.textContent = this.itemIcon(item);
        d.addEventListener('mouseenter', () => this.showItemTooltip(item, mine ? 'Click to remove' : ''));
        d.addEventListener('mouseleave', () => this.hideTooltip());
        if (mine) d.addEventListener('click', () => this.net.emit('trade', { action: 'remove', itemId: item.id }));
        el.appendChild(d);
      }
    };
    render('trade-mine', t.mine.items, true);
    render('trade-theirs', t.theirs.items, false);
  }

  onTradeDone(t) {
    this.tradeActive = false;
    $('panel-trade').classList.add('hidden');
    if (!t.ok && t.reason) this.chatLine({ from: 'System', text: t.reason, channel: 'system' });
    if (t.ok) sfx.coin();
  }

  // --- talents -----------------------------------------------------------------
  renderTalents() {
    const body = $('talent-body');
    if (!body || !this.charInfo) return;
    const tree = TALENTS[this.charInfo.class] || [];
    const mine = this.inv?.talents || {};
    const points = this.inv?.talentPoints ?? 0;
    const arena = this.inv?.arena;
    body.innerHTML = `
      <div style="padding:8px 14px 0;display:flex;justify-content:space-between;align-items:center">
        <span class="unspent">✦ ${points} points</span>
        <button class="btn-small" id="t-respec">Respec (${100 * (this.self?.level || 1)}g)</button>
      </div>
      <div class="talent-cols">
        ${tree.map(br => `
          <div class="talent-col">
            <h4>${br.icon} ${br.name}</h4>
            ${br.nodes.map((n, i) => {
              const rank = mine[n.id] || 0;
              const prevOk = i === 0 || (mine[br.nodes[i - 1].id] || 0) > 0;
              const locked = !prevOk || (rank === 0 && points === 0);
              return `<div class="tnode ${n.keystone ? 'keystone' : ''} ${rank >= n.max ? 'maxed' : ''} ${locked && rank === 0 ? 'locked' : ''}"
                data-id="${n.id}" title="${n.desc}">
                <span>${n.name}</span><span class="tn-rank">${rank}/${n.max}</span>
              </div>`;
            }).join('')}
          </div>`).join('')}
      </div>
      ${arena ? `<div class="tt-muted" style="padding:0 14px 12px;font-size:12px">
        ⚔️ Arena: ${arena.rating} rating · ${arena.wins}W/${arena.losses}L · type <b>/arena</b> in chat to queue</div>` : ''}`;
    body.querySelectorAll('.tnode').forEach(el =>
      el.addEventListener('click', () => this.net.emit('talent', { nodeId: el.dataset.id })));
    $('t-respec').addEventListener('click', () => this.net.emit('respecTalents'));
  }

  // --- guild -------------------------------------------------------------------
  onGuildInvite(g) {
    const toast = $('party-toast');
    toast.classList.remove('hidden');
    toast.innerHTML = `<b>${g.from}</b> invited you to guild <b>&lt;${g.guild}&gt;</b><br>
      <button class="btn-primary" id="gi-accept">Join</button>
      <button class="btn-small" id="gi-decline">Decline</button>`;
    $('gi-accept').addEventListener('click', () => { this.net.emit('guild', { action: 'accept' }); toast.classList.add('hidden'); });
    $('gi-decline').addEventListener('click', () => toast.classList.add('hidden'));
    setTimeout(() => toast.classList.add('hidden'), 30000);
  }

  renderGuild() {
    const body = $('guild-body');
    if (!body) return;
    const g = this.guild;
    if (!g) {
      body.innerHTML = `
        <div style="padding:14px">
          <div class="tt-muted" style="margin-bottom:10px">You are not in a guild. Found one (500g) or get invited.</div>
          <div class="name-row" style="width:100%">
            <input id="guild-name-input" type="text" placeholder="Guild name" maxlength="16" style="flex:1;padding:8px;border-radius:8px;border:1px solid var(--panel-border);background:#0d1120;color:var(--text)">
            <button id="guild-create" class="btn-small">Found (500g)</button>
          </div>
        </div>`;
      $('guild-create').addEventListener('click', () =>
        this.net.emit('guild', { action: 'create', name: $('guild-name-input').value }));
      return;
    }
    body.innerHTML = `
      <div style="padding:12px 14px">
        <div class="q-name" style="font-size:16px">&lt;${g.name}&gt; <span class="lvl">Lv ${g.level}</span></div>
        <div class="tt-muted" style="font-size:12px">XP ${g.xp} / next ${g.nextXp} · +${Math.min(10, g.level - 1)}% member XP</div>
        <div style="margin:6px 0;font-size:13px">📜 ${escapeHtml(g.motd || '')}</div>
        <div class="q-name" style="margin-top:6px">🏦 Bank: ${g.bank}g</div>
        <div style="display:flex;gap:6px;margin:6px 0">
          <input id="gb-amount" type="number" min="1" value="10" style="width:80px;padding:5px;border-radius:6px;border:1px solid var(--panel-border);background:#0d1120;color:var(--text)">
          <button class="btn-small" id="gb-dep">Deposit</button>
          <button class="btn-small" id="gb-wd">Withdraw</button>
        </div>
        <div class="q-name" style="margin-top:8px">Members (${g.members.length})</div>
        ${g.members.map(m => `<div class="stat-row" style="font-size:13px">
          <span>${m.online ? '🟢' : '⚫'} ${m.name} <span class="tt-muted">Lv${m.level}</span></span>
          <span class="tt-muted">${m.rank}</span></div>`).join('')}
        <div style="display:flex;gap:6px;margin-top:8px">
          <input id="g-target" type="text" placeholder="player name" style="flex:1;padding:5px;border-radius:6px;border:1px solid var(--panel-border);background:#0d1120;color:var(--text)">
          <button class="btn-small" id="g-inv">Invite</button>
          <button class="btn-small" id="g-promote">Rank±</button>
          <button class="btn-small" id="g-kick">Kick</button>
        </div>
        <div class="tt-muted" style="font-size:11px;margin-top:8px">${(g.log || []).slice(-6).map(escapeHtml).join('<br>')}</div>
        <button class="btn-small" id="g-leave" style="margin-top:8px;color:#ff7675">Leave guild</button>
        <div class="tt-muted" style="font-size:11px;margin-top:4px">Guild chat: /g message</div>
      </div>`;
    const val = () => $('g-target').value.trim();
    $('gb-dep').addEventListener('click', () => this.net.emit('guild', { action: 'deposit', amount: +$('gb-amount').value }));
    $('gb-wd').addEventListener('click', () => this.net.emit('guild', { action: 'withdraw', amount: +$('gb-amount').value }));
    $('g-inv').addEventListener('click', () => this.net.emit('guild', { action: 'invite', name: val() }));
    $('g-promote').addEventListener('click', () => this.net.emit('guild', { action: 'promote', name: val() }));
    $('g-kick').addEventListener('click', () => this.net.emit('guild', { action: 'kick', name: val() }));
    $('g-leave').addEventListener('click', () => { if (confirm('Leave guild?')) this.net.emit('guild', { action: 'leave' }); });
  }

  // --- market ------------------------------------------------------------------
  renderMarket() {
    const body = $('market-body');
    if (!body) return;
    const m = this.market;
    if (!m) { body.innerHTML = '<div class="tt-muted" style="padding:14px">Loading…</div>'; return; }
    body.innerHTML = `
      <div style="padding:10px 14px">
        <button class="btn-small" id="mk-sell-mode">${this.marketSellMode ? '← Back to listings' : '＋ Sell an item'}</button>
        <div id="mk-list" style="margin-top:8px;max-height:340px;overflow-y:auto"></div>
      </div>`;
    $('mk-sell-mode').addEventListener('click', () => { this.marketSellMode = !this.marketSellMode; this.renderMarket(); });
    const list = $('mk-list');
    if (this.marketSellMode) {
      const items = this.inv?.inventory || [];
      if (!items.length) { list.innerHTML = '<div class="tt-muted">Your bag is empty.</div>'; return; }
      for (const item of items) {
        const r = RARITIES[item.rarity];
        const row = document.createElement('div');
        row.className = 'craft-row';
        row.innerHTML = `
          <div class="cr-icon">${this.itemIcon(item)}</div>
          <div class="cr-body"><div class="cr-name" style="color:${r.color}">${item.name}${item.enchant ? ' +' + item.enchant : ''}</div>
          <div class="tt-muted" style="font-size:11px">min ${Math.max(1, item.sellValue)}g</div></div>
          <input type="number" class="mk-price" value="${item.sellValue * 3}" min="1" style="width:70px;padding:4px;border-radius:6px;border:1px solid var(--panel-border);background:#0d1120;color:var(--text)">
          <button class="btn-small mk-do-sell" data-id="${item.id}">List</button>`;
        row.querySelector('.mk-do-sell').addEventListener('click', () => {
          this.net.emit('market', { action: 'sell', itemId: item.id, price: +row.querySelector('.mk-price').value });
          this.marketSellMode = false;
        });
        list.appendChild(row);
      }
      return;
    }
    if (!m.orders.length) { list.innerHTML = '<div class="tt-muted">No listings yet — be the first!</div>'; return; }
    for (const o of m.orders) {
      const r = RARITIES[o.item.rarity];
      const row = document.createElement('div');
      row.className = 'craft-row';
      row.innerHTML = `
        <div class="cr-icon">${this.itemIcon(o.item)}</div>
        <div class="cr-body">
          <div class="cr-name" style="color:${r.color}">${o.item.name}${o.item.enchant ? ' +' + o.item.enchant : ''}</div>
          <div class="tt-muted" style="font-size:11px">iLvl ${o.item.level} · by ${o.seller}</div>
        </div>
        <span style="color:var(--gold);font-weight:700">${o.price}g</span>
        ${o.mine
          ? `<button class="btn-small mk-cancel" data-id="${o.id}">Cancel</button>`
          : `<button class="btn-small mk-buy" data-id="${o.id}">Buy</button>`}`;
      const item = o.item;
      row.querySelector('.cr-icon').addEventListener('mouseenter', () => this.showItemTooltip(item, ''));
      row.querySelector('.cr-icon').addEventListener('mouseleave', () => this.hideTooltip());
      row.querySelector('.mk-buy')?.addEventListener('click', () => this.net.emit('market', { action: 'buy', orderId: o.id }));
      row.querySelector('.mk-cancel')?.addEventListener('click', () => this.net.emit('market', { action: 'cancel', orderId: o.id }));
      list.appendChild(row);
    }
  }

  // --- world boss timer -------------------------------------------------------
  setWorldBoss(wb) {
    const el = $('wb-timer');
    el.classList.remove('hidden');
    if (wb.state === 'alive') el.innerHTML = `🌋 <b>${wb.name}</b><br>ALIVE at (${Math.round(wb.x)}, ${Math.round(wb.z)})!`;
    else el.classList.add('hidden');
  }

  setWorldBossList(list) {
    const el = $('wb-timer');
    if (!list?.length) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    this.wbList = list;
    this.renderWbTimer();
    clearInterval(this.wbInterval);
    this.wbInterval = setInterval(() => {
      for (const wb of this.wbList) if (wb.inSec > 0) wb.inSec--;
      this.renderWbTimer();
    }, 1000);
  }

  renderWbTimer() {
    const el = $('wb-timer');
    el.innerHTML = this.wbList.map(wb => {
      if (wb.state === 'alive') return `🌋 <b>${wb.name}</b><br>ALIVE at (${Math.round(wb.x)}, ${Math.round(wb.z)})`;
      const m = Math.floor(wb.inSec / 60), s = wb.inSec % 60;
      return `🌋 <b>${wb.name.split(',')[0]}</b> in ${m}:${String(s).padStart(2, '0')}`;
    }).join('<br>');
  }

  // --- zone / dungeon prompts ------------------------------------------------------------
  updateZone(map, x, z) {
    let zone;
    if (map === 'world') zone = inTown(x, z) ? '🏰 Havenbrook (Safe Town)' : biomeAt(x / TILE, z / TILE).name;
    else zone = DUNGEONS[map]?.name || map;
    setZone(zoneKeyFor(map, zone));
    if (zone !== this.lastZone) {
      this.lastZone = zone;
      const b = $('zone-banner');
      b.textContent = zone;
      b.classList.add('show');
      clearTimeout(this.zoneTimer);
      this.zoneTimer = setTimeout(() => b.classList.remove('show'), 2600);
    }
  }

  updateInteractPrompt(game, x, z) {
    const el = $('dungeon-prompt');
    const show = html => { el.classList.remove('hidden'); if (el.innerHTML !== html) el.innerHTML = html; };
    if (game.map !== 'world') {
      if (Math.hypot(x, z) < 7) show(`Press <b>[F]</b> to leave the dungeon`);
      else el.classList.add('hidden');
      return;
    }
    for (const d of Object.values(DUNGEONS)) {
      if (Math.hypot(x - d.entrance.x, z - d.entrance.z) < 8) {
        show(`<b>${d.name}</b> (Lv ${d.minLevel}+) — press <b>[F]</b> to enter`);
        return;
      }
    }
    const shrine = game.world.nearestShrine(x, z, 6);
    if (shrine) { show(`🗿 Ancient Shrine — press <b>[F]</b> for a +15% XP blessing`); return; }
    const chest = game.world.nearestChest(x, z, CHESTS.range);
    if (chest) { show(`💰 Loot chest — press <b>[F]</b> to open`); return; }
    const node = game.world.nearestNode(x, z, GATHER.range);
    if (node) {
      const n = node.userData.node;
      const kind = n.kind;
      show(`${MAT_ICONS[kind] || ''} T${n.tier} ${MAT_NAMES[kind]} — press <b>[F]</b> to gather`);
      return;
    }
    el.classList.add('hidden');
  }

  // --- chat / announcements ---------------------------------------------------------------
  chatLine(c) {
    const log = $('chat-log');
    const div = document.createElement('div');
    if (c.channel === 'system') { div.className = 'c-system'; div.textContent = `⚙ ${c.text}`; }
    else if (c.channel === 'party') { div.className = 'c-party'; div.textContent = c.text; }
    else div.innerHTML = `<span class="c-name">${escapeHtml(c.from)}:</span> ${escapeHtml(c.text)}`;
    log.appendChild(div);
    while (log.children.length > 80) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }

  announce(text, color) {
    const el = document.createElement('div');
    el.className = 'ann';
    el.textContent = text;
    if (color) el.style.color = color;
    $('announce').appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  announceXp(amount) {
    // small, non-spammy xp feedback in chat only for big chunks
    if (amount >= 100) this.chatLine({ from: 'System', text: `+${amount} XP`, channel: 'system' });
  }

  flashHurt() {
    document.body.style.boxShadow = 'inset 0 0 120px rgba(231, 60, 60, .5)';
    setTimeout(() => { document.body.style.boxShadow = ''; }, 120);
  }

  showDeath() { $('death-overlay').classList.remove('hidden'); }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
