import { SetMetadata } from '@nestjs/common';

/**
 * Marks a controller class or handler as requiring one or more license features.
 *
 * Semantics:
 *  - Multiple keys → the tenant must have ALL of them ("AND").
 *  - Class-level + method-level → both apply; method requirements ADD to class
 *    requirements (the {@link FeatureGuard} unions the two metadata sets).
 *  - No-arg `@RequireFeature()` is a coding error; the type signature requires at
 *    least one key, so it fails to compile.
 *
 * The keys are matched against the catalog at app boot (warning only — unknown
 * keys still work but are flagged in logs by EntitlementsService).
 *
 * @example
 *   @RequireFeature('module_portfolios')
 *   @Controller('portfolios')
 *   export class PortfoliosController { ... }
 *
 *   @RequireFeature('module_site_studio', 'feature_custom_branding')
 *   @Get('branded-funnel')
 *   getBrandedFunnel() { ... }
 */
export const REQUIRE_FEATURE_KEY = 'require_feature';

export const RequireFeature = (firstKey: string, ...restKeys: string[]) =>
  SetMetadata(REQUIRE_FEATURE_KEY, [firstKey, ...restKeys]);
