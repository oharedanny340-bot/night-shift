/*
  NIGHT SHIFT v0.2 - a rooftop courier platformer (Phaser 3, plain script).

  CONTROLS
    Left/Right or A/D ... run
    SPACE, W or UP ...... jump (hold for higher, tap for a hop)
    SHIFT or X .......... swap which neon color is solid (blue <-> pink)
    R ................... restart the current level (on the final win screen: start again at level 1)

  HOW THE CODE IS ORGANIZED
    1. TUNING      - every number from DESIGN.md, in one place.
    2. init()      - reads which level to play (passed in by scene.restart({ level: n })).
       preload()   - loads level1-3.json, palette.json and story.json.
    3. create()    - builds the current level from its rows, then the player, drones, HUD and text.
    4. update()    - input -> movement (coyote time + jump buffer) -> swap -> drones -> win/lose.
    5. Helpers     - drawing functions, the swap, level flow (delivered banner) and small utilities.
  Everything is drawn with shapes in palette colors, so there are no image files.
*/

// ---------- 1. TUNING (straight from DESIGN.md) ----------
var TUNING = {
  tile: 32,
  playerW: 22, playerH: 28,
  runSpeed: 220,
  accelGround: 2000, accelAir: 1400,
  frictionGround: 2400, frictionAir: 600,
  gravity: 1400,
  jumpVelocity: -560,
  jumpCut: 0.5,          // releasing jump while rising multiplies velocity.y by this
  maxFall: 720,
  coyoteTime: 0.10,      // seconds you can still jump after leaving a ledge
  jumpBuffer: 0.10,      // seconds a jump press is remembered before landing
  swapCooldown: 0.12,
  droneW: 28, droneH: 16, droneHitInset: 4,
  droneSpeed: 90,
  dronePatrolTiles: 3,   // tiles left and right of its E tile
  cameraLerp: 0.12,
  loseDelay: 1000,       // ms before auto-restart
  ghostAlpha: 0.25, pendingAlpha: 0.7, blinkMs: 100,
  hintMs: 6000,          // the level hint shows for the first 6 s of a level
  hintFadeMs: 300,       // ...and fades out over its last 0.3 s
  deliveredMs: 1500      // "Delivered N/3" banner time before the next level
};

// The levels, played in order. Index 0 = level1.json.
var LEVEL_COUNT = 3;

var MainScene = new Phaser.Class({
  Extends: Phaser.Scene,
  initialize: function MainScene() { Phaser.Scene.call(this, { key: 'main' }); },

  // ---------- 2. INIT + PRELOAD ----------
  // scene.restart({ level: n }) passes data here, so the level index survives restarts.
  init: function (data) {
    this.levelIndex = (data && typeof data.level === 'number') ? data.level : 0;
  },

  preload: function () {
    // Only load once; on restart the files are already in the cache.
    for (var i = 1; i <= LEVEL_COUNT; i++) {
      if (!this.cache.json.exists('level' + i)) this.load.json('level' + i, 'levels/level' + i + '.json');
    }
    if (!this.cache.json.exists('palette')) this.load.json('palette', 'palette.json');
    if (!this.cache.json.exists('story')) this.load.json('story', 'story.json');
  },

  // ---------- 3. CREATE ----------
  create: function () {
    var T = TUNING;
    this.level = this.cache.json.get('level' + (this.levelIndex + 1));
    this.pal = this.cache.json.get('palette');
    this.story = this.cache.json.get('story');

    var rows = this.level.rows;
    this.levelW = rows[0].length * T.tile;
    this.levelH = rows.length * T.tile;

    this.state = 'play';        // 'play', 'delivered' (banner between levels), 'won' (all 3 done) or 'lost'
    this.active = 'blue';       // blue is solid at the start
    this.coyote = 0;            // time left to jump after leaving ground
    this.buffer = 0;            // time left on a buffered jump press
    this.swapTimer = 0;         // swap cooldown
    this.isJumping = false;     // true while rising from a jump (for the jump cut)
    this.facing = 1;

    this.cameras.main.setBackgroundColor(this.pal.sky);
    this.drawBackground();

    // Build the level from its rows. Each symbol becomes something.
    var groundGfx = this.add.graphics().setDepth(2);
    this.groundGroup = this.physics.add.staticGroup();
    this.platGroup = this.physics.add.staticGroup();
    this.platforms = [];        // every b/k tile: { color, state, gfx, zone, x, y }
    this.drones = [];
    this.goals = [];
    var start = null;

    for (var r = 0; r < rows.length; r++) {
      for (var c = 0; c < rows[r].length; c++) {
        var ch = rows[r][c];
        var x = c * T.tile, y = r * T.tile;
        if (ch === '#') {
          this.addGround(groundGfx, x, y, r === 0 || rows[r - 1][c] !== '#');
        } else if (ch === 'b' || ch === 'k') {
          this.addPlatform(ch === 'b' ? 'blue' : 'pink', x, y);
        } else if (ch === 'P') {
          start = { x: x + T.tile / 2, y: y + T.tile - T.playerH / 2 }; // stand on the tile below
        } else if (ch === 'E') {
          this.addDrone(x + T.tile / 2, y + T.tile / 2);
        } else if (ch === 'G') {
          this.addGoal(x, y);
        } else if (ch !== '.') {
          console.warn('Unknown level symbol "' + ch + '" at row ' + r + ', col ' + c);
        }
      }
    }
    if (!start) start = { x: 48, y: 100 };

    // Player: a yellow rectangle with an arcade body. Deco (visor, bag) is drawn on top.
    this.player = this.add.rectangle(start.x, start.y, T.playerW, T.playerH, this.col('player')).setDepth(10);
    this.physics.add.existing(this.player);
    this.player.body.setMaxVelocity(1000, T.maxFall);
    this.player.body.setCollideWorldBounds(true);
    this.playerDeco = this.add.graphics().setDepth(11);

    // World: walls left/right, open top and bottom (falling off = lose).
    this.physics.world.gravity.y = T.gravity;
    this.physics.world.setBounds(0, 0, this.levelW, this.levelH);
    this.physics.world.setBoundsCollision(true, true, false, false);

    // Ground is always solid. Platforms only collide when their state is 'solid'.
    this.physics.add.collider(this.player, this.groundGroup);
    this.physics.add.collider(this.player, this.platGroup, null, function (p, zone) {
      return zone.tileRef.state === 'solid';
    }, this);

    // Camera follows x only (the level is exactly one screen tall).
    this.cameras.main.setBounds(0, 0, this.levelW, this.levelH);
    this.cameras.main.startFollow(this.player, true, T.cameraLerp, 0);

    // Input. Phaser captures these keys, so SPACE and arrows won't scroll the page.
    this.cursors = this.input.keyboard.createCursorKeys();
    this.keys = this.input.keyboard.addKeys('A,D,W,X,R');

    this.applySwap(true);   // sets every platform's starting look (blue solid)
    this.createHud();
    this.createStoryText();

    // Draw the player's visor and bag AFTER physics moves the body (no 1-frame lag).
    this.events.on('postupdate', this.drawPlayerDeco, this);
    this.events.once('shutdown', function () {
      this.events.off('postupdate', this.drawPlayerDeco, this);
    }, this);
  },

  // ---------- 4. UPDATE ----------
  update: function (time, delta) {
    var T = TUNING;
    var dt = delta / 1000;
    var JustDown = Phaser.Input.Keyboard.JustDown;

    // R restarts the current level (also on the lose screen). On the final win
    // screen it starts the night over at level 1. It does nothing during the banner.
    if (JustDown(this.keys.R) && this.state !== 'delivered') {
      var next = (this.state === 'won') ? 0 : this.levelIndex;
      this.scene.restart({ level: next });
      return;
    }

    this.drawDrones(time);
    if (this.state !== 'play') return;   // frozen after win or lose

    var body = this.player.body;
    var onGround = body.blocked.down || body.touching.down;

    // --- Run: accelerate toward the target speed, or slow down with friction ---
    var dir = 0;
    if (this.cursors.left.isDown || this.keys.A.isDown) dir -= 1;
    if (this.cursors.right.isDown || this.keys.D.isDown) dir += 1;
    var vx = body.velocity.x;
    if (dir !== 0) {
      var accel = onGround ? T.accelGround : T.accelAir;
      vx = this.approach(vx, dir * T.runSpeed, accel * dt);
      this.facing = dir;
    } else {
      var fric = onGround ? T.frictionGround : T.frictionAir;
      vx = this.approach(vx, 0, fric * dt);
    }
    body.setVelocityX(vx);

    // --- Jump: coyote time + jump buffer ---
    var jumpPressed = JustDown(this.cursors.space) || JustDown(this.cursors.up) || JustDown(this.keys.W);
    var jumpHeld = this.cursors.space.isDown || this.cursors.up.isDown || this.keys.W.isDown;

    if (onGround) this.coyote = T.coyoteTime; else this.coyote -= dt;
    if (jumpPressed) this.buffer = T.jumpBuffer; else this.buffer -= dt;

    if (this.buffer > 0 && this.coyote > 0) {
      body.setVelocityY(T.jumpVelocity);
      this.buffer = 0;
      this.coyote = 0;          // no double jumps
      this.isJumping = true;
    }
    // Let go early while rising = shorter hop (only once per jump).
    if (this.isJumping && !jumpHeld && body.velocity.y < 0) {
      body.setVelocityY(body.velocity.y * T.jumpCut);
      this.isJumping = false;
    }
    if (body.velocity.y >= 0) this.isJumping = false;

    // --- Swap (SHIFT or X), key-down only, with a short cooldown ---
    this.swapTimer -= dt;
    if ((JustDown(this.cursors.shift) || JustDown(this.keys.X)) && this.swapTimer <= 0) {
      this.swapTimer = T.swapCooldown;
      this.active = (this.active === 'blue') ? 'pink' : 'blue';
      this.applySwap(false);
    }
    this.updatePending(time);

    // --- Drones patrol back and forth ---
    for (var i = 0; i < this.drones.length; i++) {
      var d = this.drones[i];
      d.x += d.dir * T.droneSpeed * dt;
      if (d.x > d.maxX) { d.x = d.maxX; d.dir = -1; }
      if (d.x < d.minX) { d.x = d.minX; d.dir = 1; }
    }

    // --- Win / lose checks ---
    var pr = this.playerRect();
    for (var g = 0; g < this.goals.length; g++) {
      if (this.overlaps(pr, this.goals[g])) { this.win(); return; }
    }
    for (var j = 0; j < this.drones.length; j++) {
      if (this.overlaps(pr, this.droneHitbox(this.drones[j]))) { this.lose(); return; }
    }
    if (body.y > this.levelH) this.lose();   // player's top fell below the level
  },

  // ---------- 5. HELPERS ----------

  // Palette name -> Phaser color number
  col: function (name) {
    return Phaser.Display.Color.HexStringToColor(this.pal[name]).color;
  },

  // Move value toward target by at most step
  approach: function (value, target, step) {
    if (value < target) return Math.min(value + step, target);
    return Math.max(value - step, target);
  },

  // Rectangles are { x, y, w, h } with x/y at the top-left
  overlaps: function (a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  },

  playerRect: function () {
    var b = this.player.body;
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  },

  // Far skyline (parallax 0.3) and a haze band; purely decoration
  drawBackground: function () {
    var W = this.scale.width, H = this.scale.height;
    var glow = this.add.graphics().setScrollFactor(0).setDepth(0);
    glow.fillStyle(this.col('sky_glow'), 1);
    glow.fillRect(0, H * 2 / 3, W, H / 3);

    var city = this.add.graphics().setScrollFactor(0.3).setDepth(1);
    var seed = 7;                                       // fixed seed = same skyline every run
    var rand = function () { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    var width = this.levelW * 0.3 + W;
    for (var x = 0; x < width; ) {
      var bw = 40 + Math.floor(rand() * 60);
      var bh = 80 + Math.floor(rand() * 180);
      var top = H - bh;
      city.fillStyle(this.col('city'), 1);
      city.fillRect(x, top, bw, bh);
      city.fillStyle(this.col('city_window'), 0.5);     // tiny lit windows
      for (var wy = top + 8; wy < H - 8; wy += 12) {
        for (var wx = x + 6; wx < x + bw - 6; wx += 10) {
          if (rand() < 0.25) city.fillRect(wx, wy, 3, 4);
        }
      }
      x += bw + 4 + Math.floor(rand() * 10);
    }
  },

  // '#' tile: always solid, with a light top edge if nothing is above it
  addGround: function (gfx, x, y, exposed) {
    var T = TUNING;
    gfx.fillStyle(this.col('ground'), 1);
    gfx.fillRect(x, y, T.tile, T.tile);
    if (exposed) {
      gfx.fillStyle(this.col('ground_edge'), 1);
      gfx.fillRect(x, y, T.tile, 2);
    }
    var zone = this.add.zone(x + T.tile / 2, y + T.tile / 2, T.tile, T.tile);
    this.groundGroup.add(zone);
  },

  // 'b' or 'k' tile: a neon platform that is solid only when its color is active
  addPlatform: function (color, x, y) {
    var T = TUNING;
    var zone = this.add.zone(x + T.tile / 2, y + T.tile / 2, T.tile, T.tile);
    this.platGroup.add(zone);
    var tile = { color: color, state: 'solid', x: x, y: y, zone: zone, gfx: this.add.graphics().setDepth(3) };
    zone.tileRef = tile;   // so the collider can look up the tile's state
    this.platforms.push(tile);
  },

  // Draw one platform tile. fillAlpha: 1 = solid, 0.25 = ghost, 0.7 = pending blink.
  drawPlatform: function (t, fillAlpha) {
    var g = t.gfx, c = this.col(t.color), sky = this.col('sky');
    var x = t.x, y = t.y;
    g.clear();
    g.fillStyle(c, fillAlpha);
    g.fillRect(x + 1, y + 1, 30, 30);
    // The mark tells blue and pink apart without color: bar = blue, diamond = pink
    g.fillStyle(sky, t.state === 'solid' ? 1 : 0.6);
    if (t.color === 'blue') {
      g.fillRect(x + 1, y + 14, 30, 4);
    } else {
      var cx = x + 16, cy = y + 16;
      g.fillPoints([{ x: cx, y: cy - 4 }, { x: cx + 4, y: cy }, { x: cx, y: cy + 4 }, { x: cx - 4, y: cy }], true);
    }
    if (t.state !== 'solid') {          // thin outline so ghosts can still be planned with
      g.lineStyle(1, c, 0.6);
      g.strokeRect(x + 1.5, y + 1.5, 29, 29);
    }
  },

  // The swap rule (DESIGN.md): the new color turns solid, except tiles inside the
  // player, which become 'pending' until the player steps out. Never pushes or kills.
  applySwap: function (isStart) {
    var pr = this.playerRect();
    for (var i = 0; i < this.platforms.length; i++) {
      var t = this.platforms[i];
      if (t.color !== this.active) {
        t.state = 'ghost';
      } else if (!isStart && this.overlaps(pr, { x: t.x, y: t.y, w: 32, h: 32 })) {
        t.state = 'pending';
      } else {
        t.state = 'solid';
      }
      this.drawPlatform(t, t.state === 'solid' ? 1 : TUNING.ghostAlpha);
    }
    if (!isStart) {
      this.updateHud();
      this.flashScreen();
    }
  },

  // Pending tiles blink until the player no longer overlaps them, then go solid
  updatePending: function (time) {
    var pr = this.playerRect();
    var blinkOn = Math.floor(time / TUNING.blinkMs) % 2 === 0;
    for (var i = 0; i < this.platforms.length; i++) {
      var t = this.platforms[i];
      if (t.state !== 'pending') continue;
      if (!this.overlaps(pr, { x: t.x, y: t.y, w: 32, h: 32 })) {
        t.state = 'solid';
        this.drawPlatform(t, 1);
      } else {
        this.drawPlatform(t, blinkOn ? TUNING.pendingAlpha : TUNING.ghostAlpha);
      }
    }
  },

  // Quick full-screen tint in the new active color
  flashScreen: function () {
    var f = this.add.rectangle(0, 0, this.scale.width, this.scale.height, this.col(this.active), 0.12)
      .setOrigin(0, 0).setScrollFactor(0).setDepth(90);
    this.time.delayedCall(80, function () { f.destroy(); });
  },

  // 'E' tile: a drone that patrols 3 tiles each way and ignores all tiles
  addDrone: function (cx, cy) {
    var range = TUNING.dronePatrolTiles * TUNING.tile;
    this.drones.push({
      x: cx, y: cy, dir: 1, minX: cx - range, maxX: cx + range,
      gfx: this.add.graphics().setDepth(9)
    });
  },

  // The drone's hitbox is smaller than it looks (forgiveness)
  droneHitbox: function (d) {
    var T = TUNING, inset = T.droneHitInset;
    return { x: d.x - T.droneW / 2 + inset, y: d.y - T.droneH / 2 + inset,
             w: T.droneW - inset * 2, h: T.droneH - inset * 2 };
  },

  drawDrones: function (time) {
    var T = TUNING;
    var eyeOn = Math.floor(time / 500) % 2 === 0;
    for (var i = 0; i < this.drones.length; i++) {
      var d = this.drones[i], g = d.gfx;
      var left = d.x - T.droneW / 2, top = d.y - T.droneH / 2;
      g.clear();
      g.fillStyle(this.col('drone'), 1);
      g.fillRoundedRect(left, top, T.droneW, T.droneH, 4);
      g.fillRect(left + 2, top - 6, T.droneW - 4, 2);          // rotor line 4 px above
      if (eyeOn) {
        g.fillStyle(this.col('text'), 1);
        var ex = d.dir > 0 ? left + T.droneW - 8 : left + 4;    // eye on the side it's moving toward
        g.fillRect(ex, d.y - 2, 4, 4);
      }
    }
  },

  // 'G' tile: a 1-tile trigger drawn as a 2-tile-tall pulsing beacon
  addGoal: function (x, y) {
    var g = this.add.graphics().setDepth(4);
    var cx = x + 16, bottom = y + 32;
    g.fillStyle(this.col('dropoff'), 0.2);
    g.fillCircle(cx, bottom - 56, 16);                // halo
    g.fillStyle(this.col('dropoff'), 1);
    g.fillRect(cx - 5, bottom - 56, 10, 56);          // pillar
    g.fillCircle(cx, bottom - 56, 8);                 // light on top
    this.tweens.add({ targets: g, alpha: { from: 0.6, to: 1 }, duration: 800, yoyo: true, repeat: -1 });
    this.goals.push({ x: x, y: y, w: 32, h: 32 });
  },

  // Courier details: a visor on the facing side and a bag on the back
  drawPlayerDeco: function () {
    if (!this.player || !this.player.body) return;
    var g = this.playerDeco, b = this.player.body;
    g.clear();
    g.fillStyle(this.col('sky'), 1);
    var vx = this.facing > 0 ? b.x + b.width - 9 : b.x + 3;
    g.fillRect(vx, b.y + 4, 6, 6);
    g.fillStyle(this.col('player'), 1);
    var bagX = this.facing > 0 ? b.x - 6 : b.x + b.width - 2;
    g.fillRect(bagX, b.y + 10, 8, 10);
  },

  // HUD chip (top-left) that says which color is solid, in words and with its mark,
  // plus a second box after it with the level, e.g. "2/3 Mid-air"
  createHud: function () {
    this.hudGfx = this.add.graphics().setScrollFactor(0).setDepth(100);
    this.hudText = this.add.text(36, 15, '', { fontFamily: 'monospace', fontSize: '16px', fontStyle: 'bold' })
      .setScrollFactor(0).setDepth(101);

    var names = this.story.levelNames || [];
    var name = names[this.levelIndex] || this.level.name || '';
    var label = (this.levelIndex + 1) + '/' + LEVEL_COUNT + ' ' + name;
    var levelText = this.add.text(176, 15, label, {
      fontFamily: 'monospace', fontSize: '16px', fontStyle: 'bold', color: this.pal.text
    }).setScrollFactor(0).setDepth(101);
    var box = this.add.graphics().setScrollFactor(0).setDepth(100);
    box.fillStyle(this.col('hud_bg'), 0.6);
    box.fillRect(166, 8, levelText.width + 20, 32);

    this.updateHud();
  },

  updateHud: function () {
    var g = this.hudGfx, name = this.active;
    g.clear();
    g.fillStyle(this.col('hud_bg'), 0.6);
    g.fillRect(8, 8, 150, 32);
    g.fillStyle(this.col(name), 1);
    if (name === 'blue') {
      g.fillRect(16, 21, 14, 5);                       // bar mark
    } else {
      g.fillPoints([{ x: 23, y: 16 }, { x: 30, y: 23 }, { x: 23, y: 30 }, { x: 16, y: 23 }], true); // diamond
    }
    this.hudText.setText('GRID: ' + name.toUpperCase()).setColor(this.pal[name]);
  },

  // Title + intro on level 1 (fades out), and this level's hint at the top for 6 s
  createStoryText: function () {
    var W = this.scale.width, s = this.story;
    this.hintBar = null;   // the scene object is reused on restart, so clear the old one
    if (this.levelIndex === 0) {
      var title = this.add.text(W / 2, 120, s.title, {
        fontFamily: 'monospace', fontSize: '32px', fontStyle: 'bold', color: this.pal.text
      }).setOrigin(0.5).setScrollFactor(0).setDepth(100);
      var intro = this.add.text(W / 2, 175, s.intro.join('\n'), {
        fontFamily: 'monospace', fontSize: '18px', fontStyle: 'bold', color: this.pal.text, align: 'center'
      }).setOrigin(0.5).setScrollFactor(0).setDepth(100);
      this.tweens.add({ targets: [title, intro], alpha: 0, delay: 4000, duration: 800 });
    }

    // Level hint: top-center, just under the HUD row so they never overlap.
    var line = (s.levelHints || [])[this.levelIndex];
    if (!line) return;
    var hint = this.add.text(W / 2, 62, line, {
      fontFamily: 'monospace', fontSize: '16px', fontStyle: 'bold', color: this.pal.hint
    }).setOrigin(0.5).setScrollFactor(0).setDepth(101);
    var strip = this.add.rectangle(W / 2, 62, hint.width + 12, hint.height + 12, this.col('hud_bg'), 0.6)
      .setScrollFactor(0).setDepth(100);
    // Fully visible, then fade out over the last 0.3 s of the 6 s.
    this.tweens.add({ targets: [hint, strip], alpha: 0, delay: TUNING.hintMs - TUNING.hintFadeMs,
      duration: TUNING.hintFadeMs });
    this.hintBar = [strip, hint];
  },

  // Big centered message panel for lose
  showMessage: function (msg, colorName) {
    var W = this.scale.width, H = this.scale.height;
    if (this.hintBar) { this.hintBar[0].setVisible(false); this.hintBar[1].setVisible(false); }
    this.add.rectangle(W / 2, H / 2, W - 120, 80, this.col('hud_bg'), 0.75).setScrollFactor(0).setDepth(110);
    this.add.text(W / 2, H / 2, msg, {
      fontFamily: 'monospace', fontSize: '18px', fontStyle: 'bold', color: this.pal[colorName],
      align: 'center', wordWrap: { width: W - 160 }
    }).setOrigin(0.5).setScrollFactor(0).setDepth(111);
  },

  // "Delivered N/3" strip across the middle; on the last level, story.win goes under it
  showDelivered: function (isLast) {
    var W = this.scale.width, H = this.scale.height, s = this.story;
    if (this.hintBar) { this.hintBar[0].setVisible(false); this.hintBar[1].setVisible(false); }
    var top = H / 2 - 48;
    this.add.rectangle(0, top, W, 96, this.col('banner'), 0.92).setOrigin(0, 0).setScrollFactor(0).setDepth(110);
    var g = this.add.graphics().setScrollFactor(0).setDepth(111);
    g.fillStyle(this.col('dropoff'), 1);
    g.fillRect(0, top, W, 2);              // top edge line
    g.fillRect(0, top + 94, W, 2);         // bottom edge line

    var template = s.delivered || 'Delivered {n}/3';
    var msg = template.replace('{n}', this.levelIndex + 1);
    this.add.text(W / 2, isLast ? H / 2 - 16 : H / 2, msg, {
      fontFamily: 'monospace', fontSize: '28px', fontStyle: 'bold', color: this.pal.dropoff
    }).setOrigin(0.5).setScrollFactor(0).setDepth(112);
    if (isLast) {
      this.add.text(W / 2, H / 2 + 22, s.win, {
        fontFamily: 'monospace', fontSize: '18px', fontStyle: 'bold', color: this.pal.text,
        align: 'center', wordWrap: { width: W - 80 }
      }).setOrigin(0.5).setScrollFactor(0).setDepth(112);
    }
  },

  // Touched a drop-off: freeze, show the banner, then the next level (or the final win)
  win: function () {
    this.physics.pause();
    var isLast = this.levelIndex >= LEVEL_COUNT - 1;
    this.showDelivered(isLast);
    if (isLast) {
      this.state = 'won';            // stays until R, which starts level 1
    } else {
      this.state = 'delivered';      // input (R too) is frozen during the banner
      this.time.delayedCall(TUNING.deliveredMs, function () {
        this.scene.restart({ level: this.levelIndex + 1 });
      }, [], this);
    }
  },

  lose: function () {
    this.state = 'lost';
    this.physics.pause();
    this.showMessage(this.story.lose, 'text');
    this.time.delayedCall(TUNING.loseDelay, function () {
      this.scene.restart({ level: this.levelIndex });   // only the current level
    }, [], this);
  }
});

// Game config: 800x480 canvas (15 rows x 32 px), arcade physics
var config = {
  type: Phaser.AUTO,
  width: 800,
  height: 480,
  backgroundColor: '#0b0a1f',
  physics: { default: 'arcade', arcade: { debug: false } },
  scene: [MainScene]
};

var game = new Phaser.Game(config);
