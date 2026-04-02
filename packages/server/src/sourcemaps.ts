/**
 * Sourcemap upload, list, and delete API.
 * CI/CD uploads .map files per release, server uses them to translate
 * minified stack frames on ingest.
 */
import type { Router } from "express";
import { Router as createRouter } from "express";
import express from "express";
import type pg from "pg";

export function createSourcemapsRouter(pool: pg.Pool): Router {
  const router = createRouter();

  // Higher body limit for sourcemap uploads (maps can be 10-50MB)
  router.use("/api/v1/sourcemaps", express.json({ limit: "50mb" }));

  // POST /api/v1/sourcemaps — upload a sourcemap
  router.post("/api/v1/sourcemaps", async (req, res) => {
    try {
      // Auth via Bearer token (same as ingest)
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith("Bearer ")) {
        res.status(401).json({ error: "Missing or invalid authorization" });
        return;
      }

      const authKey = authHeader.slice(7);
      const projResult = await pool.query(
        "SELECT id FROM projects WHERE auth_key = $1",
        [authKey],
      );

      if (projResult.rows.length === 0) {
        res.status(401).json({ error: "Invalid auth key" });
        return;
      }

      const projectId = projResult.rows[0].id;
      const { release, fileName, sourcemapJson } = req.body as {
        release?: string;
        fileName?: string;
        sourcemapJson?: string;
      };

      if (!release || !fileName || !sourcemapJson) {
        res.status(400).json({
          error: "Missing required fields: release, fileName, sourcemapJson",
        });
        return;
      }

      // Validate sourcemap JSON
      try {
        JSON.parse(sourcemapJson);
      } catch {
        res.status(400).json({ error: "Invalid sourcemap JSON" });
        return;
      }

      const id = `smap_${randomId()}`;

      await pool.query(
        `INSERT INTO sourcemaps (id, project_id, release, file_name, sourcemap_json)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (project_id, release, file_name)
         DO UPDATE SET sourcemap_json = EXCLUDED.sourcemap_json`,
        [id, projectId, release, fileName, sourcemapJson],
      );

      res.status(201).json({ uploaded: true, release, fileName });
    } catch (err) {
      console.error("[costkey] Sourcemap upload error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/v1/sourcemaps/:release — list sourcemaps for a release
  router.get("/api/v1/sourcemaps/:release", async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith("Bearer ")) {
        res.status(401).json({ error: "Missing or invalid authorization" });
        return;
      }

      const authKey = authHeader.slice(7);
      const projResult = await pool.query(
        "SELECT id FROM projects WHERE auth_key = $1",
        [authKey],
      );

      if (projResult.rows.length === 0) {
        res.status(401).json({ error: "Invalid auth key" });
        return;
      }

      const projectId = projResult.rows[0].id;
      const { release } = req.params;

      const result = await pool.query(
        `SELECT id, file_name, created_at, length(sourcemap_json) as size_bytes
         FROM sourcemaps WHERE project_id = $1 AND release = $2
         ORDER BY file_name`,
        [projectId, release],
      );

      res.json({ release, sourcemaps: result.rows });
    } catch (err) {
      console.error("[costkey] Sourcemap list error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // DELETE /api/v1/sourcemaps/:release — delete all sourcemaps for a release
  router.delete("/api/v1/sourcemaps/:release", async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith("Bearer ")) {
        res.status(401).json({ error: "Missing or invalid authorization" });
        return;
      }

      const authKey = authHeader.slice(7);
      const projResult = await pool.query(
        "SELECT id FROM projects WHERE auth_key = $1",
        [authKey],
      );

      if (projResult.rows.length === 0) {
        res.status(401).json({ error: "Invalid auth key" });
        return;
      }

      const projectId = projResult.rows[0].id;
      const { release } = req.params;

      const result = await pool.query(
        "DELETE FROM sourcemaps WHERE project_id = $1 AND release = $2",
        [projectId, release],
      );

      res.json({ deleted: result.rowCount, release });
    } catch (err) {
      console.error("[costkey] Sourcemap delete error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

function randomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
