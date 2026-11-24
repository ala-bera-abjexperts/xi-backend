/**
 * Keys inside space_templates.config that must never be {{ }}-substituted.
 *
 * applyTemplateToSpace rebuilds four remap tables while provisioning — statusKeyMap,
 * fieldKeyMap, fieldGroupNameMap and nodeIdMap — and they are keyed by *string equality*
 * on portable identifiers rather than by uuid. Rewriting either side of one of those pairs
 * makes the lookup miss, and every miss is swallowed by an existing logger.warn, so the
 * damage shows up much later as a workflow with missing transitions.
 */
export const CONFIG_DENY_KEYS: ReadonlySet<string> = new Set([
  // Enums and structural discriminators — never human-facing.
  'module_type',
  'field_type',
  'contexts',
  'kind',

  // Definition side of a remap pair.
  'field_key', // custom_fields[] and field_groups[].fields[]
  'key', // task_statuses[] / priorities[] -> statusKeyMap (:662, :698)

  // Reference side — must stay byte-identical to the definition above.
  'status_key', // -> task_statuses[].key
  'initial_status_key', // -> statusKeyMap (:983)
  'to_node_label', // -> nodeIdMap (:995)
  'from_node_labels', // -> nodeIdMap (:1035)
  'screen_field_group_name', // -> fieldGroupNameMap (:1005)
]);

/**
 * Keys denied only inside a named array.
 *
 * `name` is a good substitution target on statuses, priorities, custom fields and workflows —
 * it is display text nothing looks up. It is unsafe only on field_groups[], because
 * fieldGroupNameMap is keyed by that exact string (:857) and transitions reference it via
 * screen_field_group_name.
 *
 * `label` keys nodeIdMap (:983) on workflow nodes only. Denying it globally also silenced
 * custom_fields[].options[].label, which is plain display text.
 */
export const CONFIG_SCOPED_DENY_KEYS: ReadonlyMap<
  string,
  ReadonlySet<string>
> = new Map([
  ['field_groups', new Set(['name'])],
  ['nodes', new Set(['label'])],
]);
