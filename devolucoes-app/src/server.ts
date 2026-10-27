// Consulta de Devoluções — Protheus (via API do Metabase gobeaute)
// A chave da API fica no secret METABASE_API_KEY (nunca no código).

interface Env {
  METABASE_API_KEY?: string;
  METABASE_URL?: string; // opcional; padrão abaixo
}

const DEFAULT_METABASE_URL = "https://metabase.gobeaute.com.br";
const PROTHEUS_DB_ID = 47;
const MAX_NOTAS = 1000;
const ROW_LIMIT = 2000; // limite padrão do /api/dataset do Metabase

const COLUMNS = [
  "numero_pedido_shopify",
  "filial",
  "nota_original",
  "serie_original",
  "nota_devolucao",
  "serie_devolucao",
  "data_devolucao",
  "motivo_retorno",
  "chave_nfe",
] as const;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function buildQuery(filial: string, notas: string[]): string {
  // filial e notas já foram validadas (somente dígitos), então é seguro montar os literais.
  const lista = notas.map((n) => `'${n}'`).join(",");
  return `SELECT DISTINCT
    TRIM(SC5.c5_xnumecm) AS numero_pedido_shopify,
    TRIM(SF2.F2_FILIAL)  AS filial,
    TRIM(SF2.F2_DOC)     AS nota_original,
    TRIM(SF2.F2_SERIE)   AS serie_original,
    TRIM(SD1.D1_DOC)     AS nota_devolucao,
    TRIM(SD1.D1_SERIE)   AS serie_devolucao,
    TRIM(SD1.D1_EMISSAO) AS data_devolucao,
    TRIM(SF1.F1_MOTRET)  AS motivo_retorno,
    TRIM(SF1.F1_CHVNFE)  AS chave_nfe
FROM SF2010 SF2
INNER JOIN SD1010 SD1
    ON SD1.D1_NFORI = SF2.F2_DOC
    AND SD1.D1_SERIORI = SF2.F2_SERIE
    AND SD1.D1_FILIAL = SF2.F2_FILIAL
    AND SD1.D_E_L_E_T_ = ''
INNER JOIN SF1010 SF1
    ON SF1.F1_FILIAL  = SD1.D1_FILIAL
    AND SF1.F1_DOC     = SD1.D1_DOC
    AND SF1.F1_SERIE   = SD1.D1_SERIE
    AND SF1.F1_FORNECE = SD1.D1_FORNECE
    AND SF1.F1_LOJA    = SD1.D1_LOJA
INNER JOIN SC5010 SC5
    ON SF2.F2_FILIAL = SC5.c5_filial
    AND SF2.F2_DOC = SC5.c5_nota
    AND SC5.D_E_L_E_T_ = ''
WHERE SF2.D_E_L_E_T_ = ''
  AND SF2.F2_FILIAL = '${filial}'
  AND SF2.F2_DOC IN (${lista})
ORDER BY nota_original, nota_devolucao`;
}

// Situação fiscal de cada nota de saída (SF3) + pedido Shopify (via SD2 -> SC5, inclusive itens excluídos de notas canceladas)
function buildStatusQuery(filial: string, notas: string[]): string {
  const lista = notas.map((n) => `'${n}'`).join(",");
  return `WITH f3 AS (
  SELECT TRIM(F3_NFISCAL) AS nota, TRIM(F3_SERIE) AS serie,
         MIN(TRIM(F3_EMISSAO)) AS emissao,
         MAX(NULLIF(TRIM(F3_DTCANC), '')) AS dt_cancelamento,
         MAX(NULLIF(TRIM(F3_OBSERV), '')) AS observacao
  FROM SF3010
  WHERE D_E_L_E_T_ = '' AND F3_FILIAL = '${filial}'
    AND F3_NFISCAL IN (${lista})
    AND LEFT(F3_CFO, 1) IN ('5','6','7')
  GROUP BY 1, 2
),
ped AS (
  SELECT DISTINCT ON (TRIM(D2.D2_DOC), TRIM(D2.D2_SERIE))
         TRIM(D2.D2_DOC) AS nota, TRIM(D2.D2_SERIE) AS serie, TRIM(C5.c5_xnumecm) AS pedido_shopify
  FROM SD2010 D2
  LEFT JOIN SC5010 C5 ON C5.c5_filial = D2.D2_FILIAL AND C5.c5_num = D2.D2_PEDIDO AND C5.D_E_L_E_T_ = ''
  WHERE D2.D2_FILIAL = '${filial}'
    AND D2.D2_DOC IN (${lista})
  ORDER BY TRIM(D2.D2_DOC), TRIM(D2.D2_SERIE), D2.D_E_L_E_T_
)
SELECT f3.nota, f3.serie, f3.emissao, f3.dt_cancelamento, f3.observacao, ped.pedido_shopify
FROM f3 LEFT JOIN ped ON ped.nota = f3.nota AND ped.serie = f3.serie
ORDER BY f3.nota, f3.serie`;
}

class UpstreamError extends Error {
  constructor(public publicMsg: string, public detalhe = "") {
    super(publicMsg);
  }
}

async function runQuery(env: Env, sql: string): Promise<Record<string, string>[]> {
  const base = (env.METABASE_URL || DEFAULT_METABASE_URL).replace(/\/+$/, "");
  let upstream: Response;
  try {
    upstream = await fetch(`${base}/api/dataset`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": env.METABASE_API_KEY! },
      body: JSON.stringify({ database: PROTHEUS_DB_ID, type: "native", native: { query: sql, "template-tags": {} } }),
    });
  } catch (e) {
    console.log("erro de rede ao chamar o Metabase", String(e));
    throw new UpstreamError("Não foi possível conectar ao Metabase.");
  }
  const text = await upstream.text();
  if (upstream.status === 401 || upstream.status === 403) {
    throw new UpstreamError("A chave da API do Metabase foi recusada (sem permissão ou inválida).");
  }
  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    console.log(`resposta não-JSON do Metabase status=${upstream.status}`, text.slice(0, 300));
    throw new UpstreamError(`O Metabase respondeu com erro (${upstream.status}).`);
  }
  if (!upstream.ok || payload?.status === "failed" || payload?.error) {
    console.log("erro do Metabase", upstream.status, String(payload?.error ?? "").slice(0, 500));
    throw new UpstreamError("A consulta falhou no Metabase.", String(payload?.error ?? "").slice(0, 300));
  }
  const cols: string[] = (payload?.data?.cols ?? []).map((c: any) => String(c.name).toLowerCase());
  return (payload?.data?.rows ?? []).map((r: unknown[]) => {
    const o: Record<string, string> = {};
    cols.forEach((c, i) => (o[c] = r[i] == null ? "" : String(r[i]).trim()));
    return o;
  });
}

async function handleConsulta(request: Request, env: Env): Promise<Response> {
  if (!env.METABASE_API_KEY) {
    return json({ error: "A chave da API do Metabase ainda não foi configurada no app." }, 500);
  }

  let body: { filial?: unknown; notas?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Requisição inválida." }, 400);
  }

  const filial = String(body.filial ?? "").trim();
  if (!/^\d{4}$/.test(filial)) {
    return json({ error: "Filial inválida. Use 4 dígitos, por exemplo 1401." }, 400);
  }

  if (!Array.isArray(body.notas)) {
    return json({ error: "Informe ao menos uma nota." }, 400);
  }
  const notas = Array.from(
    new Set(
      body.notas
        .map((n) => String(n).trim())
        .filter((n) => /^\d{1,9}$/.test(n))
        .map((n) => n.padStart(9, "0")),
    ),
  );
  if (notas.length === 0) return json({ error: "Nenhuma nota válida informada." }, 400);
  if (notas.length > MAX_NOTAS) {
    return json({ error: `Máximo de ${MAX_NOTAS} notas por consulta (recebidas ${notas.length}). Divida em partes.` }, 400);
  }

  const user = request.headers.get("x-godeploy-user-email") ?? "desconhecido";
  console.log(`consulta: user=${user} filial=${filial} notas=${notas.length}`);

  const started = Date.now();
  let devRows: Record<string, string>[];
  let statusRows: Record<string, string>[];
  try {
    [devRows, statusRows] = await Promise.all([
      runQuery(env, buildQuery(filial, notas)),
      runQuery(env, buildStatusQuery(filial, notas)),
    ]);
  } catch (e) {
    if (e instanceof UpstreamError) return json({ error: e.publicMsg, detalhe: e.detalhe || undefined }, 502);
    console.log("erro inesperado", String(e));
    return json({ error: "Erro inesperado ao consultar." }, 500);
  }

  const rows = devRows.map((r) => {
    const o: Record<string, string> = {};
    COLUMNS.forEach((c) => (o[c] = r[c] ?? ""));
    return o;
  });

  const comDevolucao = new Set(rows.map((r) => r.nota_original));
  const naSF3 = new Set(statusRows.map((r) => r.nota));
  const canceladas = statusRows.filter((r) => r.dt_cancelamento);
  const pendentes = statusRows.filter((r) => !r.dt_cancelamento && !comDevolucao.has(r.nota));
  const naoEncontradas = notas.filter((n) => !naSF3.has(n) && !comDevolucao.has(n));

  console.log(`ok: devolvidas=${comDevolucao.size} canceladas=${canceladas.length} pendentes=${pendentes.length} nao_encontradas=${naoEncontradas.length} ms=${Date.now() - started}`);

  return json({
    filial,
    notasPesquisadas: notas.length,
    rows,
    canceladas,
    pendentes,
    naoEncontradas,
    resumo: {
      devolvidas: comDevolucao.size,
      canceladas: new Set(canceladas.map((r) => r.nota)).size,
      pendentes: new Set(pendentes.map((r) => r.nota)).size,
      naoEncontradas: naoEncontradas.length,
    },
    truncado: rows.length >= ROW_LIMIT,
    tempoMs: Date.now() - started,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/consulta" && request.method === "POST") {
      return handleConsulta(request, env);
    }
    if (url.pathname === "/api/status") {
      return json({
        ok: true,
        chaveConfigurada: Boolean(env.METABASE_API_KEY),
        email: request.headers.get("x-godeploy-user-email") ?? null,
      });
    }
    if (url.pathname === "/api/client-error" && request.method === "POST") {
      console.log("erro no navegador:", (await request.text()).slice(0, 1000));
      return json({ ok: true });
    }
    return new Response("Not found", { status: 404 });
  },
};
