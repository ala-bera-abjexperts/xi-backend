import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

// Body for the Salesforce Lead-field picker. Only the org to describe against is supplied — the
// Connected App key/secret come from SALESFORCE_CLIENT_ID / SALESFORCE_CLIENT_SECRET on the server,
// so no credential ever crosses the wire.
export class ListSalesforceFieldsDto {
  @ApiProperty({
    description:
      'Salesforce instance URL, e.g. https://your-org.my.salesforce.com',
  })
  @IsString()
  @MaxLength(500)
  instanceUrl!: string;
}
