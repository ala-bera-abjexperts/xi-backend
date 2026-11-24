import { IsObject, IsOptional, IsString, Length } from 'class-validator';

/**
 * Body for an anonymous (or assignee-authenticated) submission to a standalone
 * published form.
 *
 * the client may name only *which* form it is submitting, via the
 * public slug in the route. `organization_id` / `space_id` / `is_test` are never
 * accepted from the client — they are derived server-side from the `form_builder`
 * row. `is_test` in particular must stay non-settable: a test submission is
 * skipped by the entire post-submission pipeline and excluded from analytics, so
 * an attacker able to set it could write rows that are invisible to every
 * surface the owner looks at.
 *
 * The global ValidationPipe runs with `forbidNonWhitelisted`, so any extra key
 * (including `is_test`) is a 400 rather than being silently ignored.
 */
export class PublicFormBuilderSubmitDto {
  /** Answers keyed by `field_key`. Unknown keys are dropped server-side. */
  @IsObject()
  data!: Record<string, unknown>;

  /**
   * Anti-spam honeypot. Hidden from humans by CSS; bots fill it in. Optional and
   * length-capped so it can never become a storage vector.
   */
  @IsOptional()
  @IsString()
  @Length(0, 200)
  hp?: string;
}
