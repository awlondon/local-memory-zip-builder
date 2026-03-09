import { clamp, padNumber } from "./utils.js";

/**
 * Thesis-aligned engineering constraints:
 *   - Maximum symbol library size: ~1,500 entries
 *   - Maximum concept tokens per symbol: 100
 *   - Symbol bin weight must be ≤ 1.00
 *   - Theoretical capacity: ~150,000 addressable concept tokens
 */
const MAX_SYMBOL_LIBRARY_SIZE = 1500;
const MAX_TOKENS_PER_SYMBOL = 100;
const MAX_BIN_WEIGHT = 1.0;

const EXTENDED_GLYPH_PALETTE = [
  "\u27C1", "\u2206", "\u27F2", "\u2211", "\u03BB", "\u2297", "\u2295",
  "\u03A9", "\u29C9", "\u221E\u0307",
  "\u2234", "\u2235", "\u2237", "\u2261", "\u2248", "\u2260", "\u2264",
  "\u2265", "\u221A", "\u222B", "\u2202", "\u2207", "\u2208", "\u2209",
  "\u2282", "\u2283", "\u2286", "\u2287", "\u222A", "\u2229", "\u2205",
  "\u22C5", "\u2227", "\u2228", "\u00AC", "\u22A2", "\u22A3", "\u22A4",
  "\u22A5", "\u2312", "\u2318", "\u2320", "\u2321", "\u23B5", "\u23B6",
  "\u2500", "\u2502", "\u250C", "\u2510", "\u2514", "\u2518", "\u251C",
  "\u2524", "\u252C", "\u2534", "\u253C", "\u2550", "\u2551", "\u2552",
  "\u2553", "\u2554", "\u2555", "\u2556", "\u2557", "\u2558", "\u2559",
  "\u255A", "\u255B", "\u255C", "\u255D", "\u255E", "\u255F", "\u2560",
  "\u2561", "\u2562", "\u2563", "\u2564", "\u2565", "\u2566", "\u2567",
  "\u2568", "\u2569", "\u256A", "\u256B", "\u256C", "\u2580", "\u2584",
  "\u2588", "\u258C", "\u2590", "\u2591", "\u2592", "\u2593",
  "\u25A0", "\u25A1", "\u25B2", "\u25B3", "\u25BC", "\u25BD", "\u25C6",
  "\u25C7", "\u25CB", "\u25CF", "\u25D0", "\u25D1", "\u25D2", "\u25D3",
  "\u25E2", "\u25E3", "\u25E4", "\u25E5",
  "\u2600", "\u2601", "\u2602", "\u2605", "\u2606", "\u260E", "\u2615",
  "\u2620", "\u2622", "\u2623", "\u2626", "\u262E", "\u262F", "\u2639",
  "\u263A", "\u2660", "\u2663", "\u2665", "\u2666", "\u2680", "\u2681",
  "\u2682", "\u2683", "\u2684", "\u2685",
  "\u2701", "\u2702", "\u2706", "\u2708", "\u2709", "\u270C", "\u270E",
  "\u2713", "\u2714", "\u2716", "\u2717", "\u271D", "\u2720", "\u2721",
  "\u2733", "\u2734", "\u2735", "\u2736", "\u2737", "\u2738", "\u2739",
  "\u273A", "\u273B", "\u273C", "\u273D",
  "\u2756", "\u2757", "\u2764", "\u2776", "\u2777", "\u2778", "\u2779",
  "\u277A", "\u277B", "\u277C", "\u277D", "\u277E", "\u277F",
  "\u2794", "\u27A1", "\u27B3", "\u27B5", "\u27B8", "\u27BA",
  "\u2B05", "\u2B06", "\u2B07", "\u2B1B", "\u2B1C", "\u2B50", "\u2B55"
];

export function buildSymbolLibrary(concepts, _chunkConcepts, edges) {
  if (!concepts.length) {
    return {
      symbols: [],
      conceptToSymbol: Object.create(null),
      capacity: {
        max_symbols: MAX_SYMBOL_LIBRARY_SIZE,
        max_tokens_per_symbol: MAX_TOKENS_PER_SYMBOL,
        max_bin_weight: MAX_BIN_WEIGHT,
        theoretical_capacity: MAX_SYMBOL_LIBRARY_SIZE * MAX_TOKENS_PER_SYMBOL,
        used_symbols: 0,
        used_tokens: 0,
        utilization: 0
      }
    };
  }

  const cooccurrenceGraph = buildCooccurrenceMap(concepts, edges);
  const clusters = clusterConcepts(concepts, cooccurrenceGraph);
  const symbols = [];
  const conceptToSymbol = Object.create(null);
  const usedGlyphs = new Set();

  for (let i = 0; i < clusters.length && symbols.length < MAX_SYMBOL_LIBRARY_SIZE; i += 1) {
    const cluster = clusters[i];
    if (!cluster.members.length) {
      continue;
    }

    const binTokens = cluster.members.slice(0, MAX_TOKENS_PER_SYMBOL);
    const rawWeight = binTokens.reduce((sum, member) => sum + member.importance, 0);
    const binWeight = clamp(rawWeight / Math.max(1, binTokens.length), 0, MAX_BIN_WEIGHT);

    const glyph = pickGlyph(symbols.length, usedGlyphs);
    usedGlyphs.add(glyph);

    const symbolId = `sym_${padNumber(symbols.length + 1)}`;
    const symbol = {
      symbol_id: symbolId,
      glyph,
      label: cluster.label,
      concept_ids: binTokens.map((member) => member.concept_id),
      bin_weight: Number(binWeight.toFixed(4)),
      token_count: binTokens.length
    };

    symbols.push(symbol);

    for (const member of binTokens) {
      conceptToSymbol[member.concept_id] = symbolId;
    }
  }

  const usedTokens = symbols.reduce((sum, symbol) => sum + symbol.token_count, 0);

  return {
    symbols,
    conceptToSymbol,
    capacity: {
      max_symbols: MAX_SYMBOL_LIBRARY_SIZE,
      max_tokens_per_symbol: MAX_TOKENS_PER_SYMBOL,
      max_bin_weight: MAX_BIN_WEIGHT,
      theoretical_capacity: MAX_SYMBOL_LIBRARY_SIZE * MAX_TOKENS_PER_SYMBOL,
      used_symbols: symbols.length,
      used_tokens: usedTokens,
      utilization: Number((usedTokens / (MAX_SYMBOL_LIBRARY_SIZE * MAX_TOKENS_PER_SYMBOL)).toFixed(6))
    }
  };
}

function buildCooccurrenceMap(concepts, edges) {
  const graph = new Map();

  for (const concept of concepts) {
    graph.set(concept.concept_id, new Map());
  }

  for (const edge of edges) {
    if (edge.type !== "often_cooccurs_with" && edge.type !== "related_to" && edge.type !== "subconcept_of") {
      continue;
    }

    if (!graph.has(edge.src) || !graph.has(edge.dst)) {
      continue;
    }

    const srcNeighbors = graph.get(edge.src);
    const dstNeighbors = graph.get(edge.dst);
    const weight = edge.weight || 0;

    srcNeighbors.set(edge.dst, Math.max(srcNeighbors.get(edge.dst) || 0, weight));
    dstNeighbors.set(edge.src, Math.max(dstNeighbors.get(edge.src) || 0, weight));
  }

  return graph;
}

function clusterConcepts(concepts, cooccurrenceGraph) {
  const assigned = new Set();
  const clusters = [];
  const sorted = [...concepts].sort((a, b) => b.importance - a.importance);

  for (const seed of sorted) {
    if (assigned.has(seed.concept_id)) {
      continue;
    }

    const members = [seed];
    assigned.add(seed.concept_id);

    const neighbors = cooccurrenceGraph.get(seed.concept_id) || new Map();
    const sortedNeighbors = [...neighbors.entries()]
      .sort((a, b) => b[1] - a[1])
      .map((entry) => entry[0]);

    for (const neighborId of sortedNeighbors) {
      if (assigned.has(neighborId) || members.length >= MAX_TOKENS_PER_SYMBOL) {
        continue;
      }

      const neighbor = concepts.find((concept) => concept.concept_id === neighborId);
      if (!neighbor) {
        continue;
      }

      members.push(neighbor);
      assigned.add(neighborId);
    }

    clusters.push({
      label: seed.label,
      members
    });
  }

  return clusters;
}

function pickGlyph(index, usedGlyphs) {
  if (index < EXTENDED_GLYPH_PALETTE.length) {
    const candidate = EXTENDED_GLYPH_PALETTE[index];
    if (!usedGlyphs.has(candidate)) {
      return candidate;
    }
  }

  for (const glyph of EXTENDED_GLYPH_PALETTE) {
    if (!usedGlyphs.has(glyph)) {
      return glyph;
    }
  }

  const block = 0x2800 + (index % 256);
  return String.fromCodePoint(block);
}
