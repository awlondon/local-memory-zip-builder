export function createTextpackResources(bundle) {
  const lexiconById = new Map((bundle.lexicon || []).map((entry) => [entry.phrase_id, entry.text]));
  const templateById = new Map((bundle.templates || []).map((entry) => [entry.template_id, entry]));
  const recordByNumber = new Map((bundle.records || []).map((entry) => [entry.record, entry]));

  return {
    literalStore: bundle.literalStore || "",
    lexiconById,
    templateById,
    recordByNumber
  };
}

export function reconstructRecord(record, resources) {
  if (!record) {
    throw new Error("Missing textpack record.");
  }

  let content;
  if (Number.isFinite(record.base_record)) {
    const baseRecord = resources.recordByNumber.get(record.base_record);
    if (!baseRecord) {
      throw new Error(`Missing base record ${record.base_record}.`);
    }
    content = applyPatch(reconstructRecord(baseRecord, resources), record.patch_ops || [], resources.literalStore);
  } else {
    const template = Number.isFinite(record.template_id) ? resources.templateById.get(record.template_id) : null;
    const inner = (record.segments || []).map((segment) => reconstructSegment(segment, resources)).join("");
    content = template ? `${template.prefix}${inner}${template.suffix}` : inner;
  }

  return content;
}

export function validateTextpackBundle(bundle, expectedByRecord) {
  const resources = createTextpackResources(bundle);
  const failures = [];
  let validated = 0;

  for (const record of bundle.records || []) {
    const reconstructed = reconstructRecord(record, resources);
    validated += 1;

    if (record.text_hash && record.text_hash !== bundle.hashText(reconstructed)) {
      failures.push({ record: record.record, reason: "hash_mismatch" });
      continue;
    }

    const expected = expectedByRecord?.get(record.record);
    if (typeof expected === "string" && expected !== reconstructed) {
      failures.push({ record: record.record, reason: "text_mismatch" });
    }
  }

  return {
    total_records: (bundle.records || []).length,
    validated_records: validated,
    failures
  };
}

function reconstructSegment(segment, resources) {
  if (segment.type === "phrase") {
    return resources.lexiconById.get(segment.phrase_id) || "";
  }

  if (!segment.literal_ref) {
    return "";
  }

  const { offset, length } = segment.literal_ref;
  return resources.literalStore.slice(offset, offset + length);
}

function applyPatch(baseText, operations, literalStore) {
  let current = String(baseText || "");

  for (const operation of operations || []) {
    if (operation.op !== "replace_range") {
      continue;
    }

    const start = Math.max(0, Math.min(current.length, operation.start || 0));
    const deleteCount = Math.max(0, operation.delete_count || 0);
    const insertText = operation.insert_ref
      ? literalStore.slice(operation.insert_ref.offset, operation.insert_ref.offset + operation.insert_ref.length)
      : "";

    current = `${current.slice(0, start)}${insertText}${current.slice(start + deleteCount)}`;
  }

  return current;
}
