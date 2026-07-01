import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";

export class App extends DurableObject {
  private app = new Hono();

  constructor(state: any, env: any) {
    super(state, env);
    this.setupDatabase();
    this.setupRoutes();
  }

  private setupDatabase() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS riders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS players (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS selections (
        player_id INTEGER,
        rider_id INTEGER,
        FOREIGN KEY(player_id) REFERENCES players(id),
        FOREIGN KEY(rider_id) REFERENCES riders(id),
        PRIMARY KEY(player_id, rider_id)
      );
      CREATE TABLE IF NOT EXISTS stage_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stage_num INTEGER NOT NULL,
        rider_id INTEGER NOT NULL,
        rank INTEGER NOT NULL,
        type TEXT NOT NULL, -- 'stage', 'yellow', 'green', 'mountain', 'white'
        FOREIGN KEY(rider_id) REFERENCES riders(id)
      );
    `);
  }

  private setupRoutes() {
    // Public: Get standings
    this.app.get("/api/standings", async (c) => {
      const players = this.ctx.storage.sql.exec(`SELECT * FROM players`).toArray();
      const riders = this.ctx.storage.sql.exec(`SELECT * FROM riders`).toArray();
      const results = this.ctx.storage.sql.exec(`SELECT * FROM stage_results`).toArray();
      const selections = this.ctx.storage.sql.exec(`SELECT * FROM selections`).toArray();

      // Calculate selection counts for bonus points
      const selectionCounts: Record<number, number> = {};
      selections.forEach((s: any) => {
        selectionCounts[s.rider_id] = (selectionCounts[s.rider_id] || 0) + 1;
      });

      const playerScores: Record<number, { id: number; name: string; score: number; riders: any[] }> = {};
      players.forEach((p: any) => {
        playerScores[p.id] = { ...p, score: 0, riders: [] };
      });

      // Map rider IDs to names for easy lookup
      const riderMap: Record<number, string> = {};
      riders.forEach((r: any) => {
        riderMap[r.id] = r.name;
      });

      // Group selections by player
      selections.forEach((s: any) => {
        if (playerScores[s.player_id]) {
          playerScores[s.player_id].riders.push({
            id: s.rider_id,
            name: riderMap[s.rider_id],
            count: selectionCounts[s.rider_id] || 0
          });
        }
      });

      // Base points configuration
      const basePoints: Record<string, number[]> = {
        stage: [0, 25, 15, 10, 8, 6, 5, 4, 3, 2, 1],
        yellow: [0, 5, 4, 3, 2, 1],
        green: [0, 5, 4, 3, 2, 1],
        mountain: [0, 5, 4, 3, 2, 1],
        white: [0, 5, 3, 1]
      };

      // Process results and award points
      results.forEach((res: any) => {
        const typeBase = basePoints[res.type] || [];
        const base = typeBase[res.rank] || 0;
        if (base === 0) return;

        const count = selectionCounts[res.rider_id] || 0;
        if (count === 0) return;

        const bonus = (base * 8) / count;
        const totalPoints = base + bonus;

        // Find players who have this rider
        selections.filter((s: any) => s.rider_id === res.rider_id).forEach((s: any) => {
          if (playerScores[s.player_id]) {
            playerScores[s.player_id].score += totalPoints;
          }
        });
      });

      const standings = Object.values(playerScores).sort((a, b) => b.score - a.score);
      return c.json({ standings });
    });

    // Public: Get stage history
    this.app.get("/api/stages", async (c) => {
      const results = this.ctx.storage.sql.exec(`
        SELECT sr.*, r.name as rider_name 
        FROM stage_results sr 
        JOIN riders r ON sr.rider_id = r.id
        ORDER BY stage_num DESC, type, rank ASC
      `).toArray();
      return c.json({ results });
    });

    // Admin: Bulk Import Riders & Players
    this.app.post("/api/admin/import", async (c) => {
      const { secret, data } = await c.req.json();
      if (secret !== "tdf2024") return c.json({ error: "Unauthorized" }, 401);

      // data format: [ { name: "Player", riders: ["Rider 1", "Rider 2", ...] } ]
      this.ctx.storage.transactionSync(() => {
        for (const playerItem of data) {
          // Insert player
          this.ctx.storage.sql.exec(`INSERT OR IGNORE INTO players (name) VALUES (?)`, playerItem.name);
          const playerId = (this.ctx.storage.sql.exec(`SELECT id FROM players WHERE name = ?`, playerItem.name).one() as any).id;

          for (const riderName of playerItem.riders) {
            // Insert rider
            this.ctx.storage.sql.exec(`INSERT OR IGNORE INTO riders (name) VALUES (?)`, riderName);
            const riderId = (this.ctx.storage.sql.exec(`SELECT id FROM riders WHERE name = ?`, riderName).one() as any).id;
            
            // Link selection
            this.ctx.storage.sql.exec(`INSERT OR IGNORE INTO selections (player_id, rider_id) VALUES (?, ?)`, playerId, riderId);
          }
        }
      });

      return c.json({ success: true });
    });

    // Admin: Save Stage Results
    this.app.post("/api/admin/results", async (c) => {
      const { secret, stage_num, results } = await c.req.json();
      if (secret !== "tdf2024") return c.json({ error: "Unauthorized" }, 401);

      // results: [ { rider_id: 1, rank: 1, type: 'stage' }, ... ]
      this.ctx.storage.transactionSync(() => {
        // Clear existing results for this stage to allow updates
        this.ctx.storage.sql.exec(`DELETE FROM stage_results WHERE stage_num = ?`, stage_num);
        
        for (const res of results) {
          this.ctx.storage.sql.exec(
            `INSERT INTO stage_results (stage_num, rider_id, rank, type) VALUES (?, ?, ?, ?)`,
            stage_num, res.rider_id, res.rank, res.type
          );
        }
      });

      return c.json({ success: true });
    });

    // Admin: Search Riders
    this.app.get("/api/admin/riders", async (c) => {
      const riders = this.ctx.storage.sql.exec(`SELECT * FROM riders ORDER BY name ASC`).toArray();
      return c.json({ riders });
    });
  }

  async fetch(request: Request) {
    return this.app.fetch(request);
  }
}
