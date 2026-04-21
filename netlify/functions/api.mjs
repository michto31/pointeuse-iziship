import { neon } from "@neondatabase/serverless";

const H = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

export default async function handler(event) {
  if (event.httpMethod === "OPTIONS") return new Response(null, { status: 204, headers: H });

  const url = process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL_UNPOOLED || process.env.NETLIFY_DATABASE_URL || "";
  if (!url) return new Response(JSON.stringify({ error: "No DB URL", keys: Object.keys(process.env).filter(k => k.includes("DATA") || k.includes("NEON")) }), { status: 500, headers: H });

  try {
    const sql = neon(url);
    const result = await sql`SELECT 1 as test`;
    return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: H });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message, stack: e.stack?.split("\n").slice(0,5) }), { status: 500, headers: H });
  }
}
