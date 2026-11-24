import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsObject } from 'class-validator';

export const WIKI_MACRO_KINDS = [
  'blogPosts',
  'rssFeed',
  'pageTree',
  'attachmentsList',
  'recentlyUpdated',
  'pageTreeSearch',
  'changeHistory',
  'spaceDetails',
  'userList',
  'userProfile',
  'profilePicture',
  'popularLabels',
  'recentlyUsedLabels',
  'relatedLabels',
  'contentByUser',
  'recentlyUpdatedDashboard',
  'contentReportTable',
  'decisionReport',
  'navigationMap',
] as const;

export type WikiMacroKind = (typeof WIKI_MACRO_KINDS)[number];

interface PageParams {
  pageId: string;
  limit?: number;
  offset?: number;
}

interface IdentityParams {
  userId?: string;
  userKey?: string;
  userName?: string;
}

export type WikiMacroRequest =
  | { kind: 'blogPosts' | 'rssFeed'; params: Record<string, string> }
  | {
      kind: 'pageTree';
      params: {
        rootPageId?: string;
        depth?: number;
        limit?: number;
        offset?: number;
      };
    }
  | { kind: 'attachmentsList'; params: PageParams }
  | {
      kind: 'recentlyUpdated';
      params: {
        limit?: number;
        offset?: number;
        types?: string[];
        hideHeading?: boolean;
      };
    }
  | {
      kind: 'pageTreeSearch';
      params: {
        rootPageId?: string;
        mode?: 'search' | 'pageIndex' | 'searchResults';
        query?: string;
        limit?: number;
        offset?: number;
      };
    }
  | { kind: 'changeHistory'; params: PageParams }
  | { kind: 'spaceDetails'; params: { width?: string } }
  | {
      kind: 'userList';
      params: {
        groups?: string[];
        online?: boolean;
        limit?: number;
        offset?: number;
      };
    }
  | { kind: 'userProfile'; params: IdentityParams }
  | { kind: 'profilePicture'; params: IdentityParams }
  | {
      kind: 'popularLabels';
      params: {
        count?: number;
        offset?: number;
        style?: 'list' | 'heatmap';
        spaceKey?: string;
      };
    }
  | {
      kind: 'recentlyUsedLabels';
      params: {
        count?: number;
        offset?: number;
        scope?: 'global' | 'space' | 'personal';
        style?: 'list' | 'table';
        title?: string;
      };
    }
  | {
      kind: 'relatedLabels';
      params: {
        labels?: string[];
        pageId?: string;
        limit?: number;
        offset?: number;
      };
    }
  | {
      kind: 'contentByUser';
      params: IdentityParams & { limit?: number; offset?: number };
    }
  | {
      kind: 'recentlyUpdatedDashboard';
      params: {
        spaceKeys?: string[];
        types?: string[];
        labels?: string[];
        users?: string[];
        width?: string;
        showProfilePic?: boolean;
        limit?: number;
        offset?: number;
      };
    }
  | {
      kind: 'contentReportTable';
      params: {
        labels: string[];
        spaceKeys?: string[];
        limit?: number;
        offset?: number;
      };
    }
  | {
      kind: 'decisionReport';
      params: {
        labels?: string[];
        spaceKeys?: string[];
        cql?: string;
        limit?: number;
        offset?: number;
      };
    }
  | {
      kind: 'navigationMap';
      params: {
        label: string;
        title?: string;
        wrapAfter?: number;
        cellWidth?: string;
        limit?: number;
        offset?: number;
      };
    };

export class ResolveWikiMacroDto {
  @ApiProperty({ enum: WIKI_MACRO_KINDS })
  @IsIn(WIKI_MACRO_KINDS)
  kind!: WikiMacroKind;

  @ApiProperty({ type: 'object', additionalProperties: true })
  @IsObject()
  params!: Record<string, unknown>;
}

export interface WikiMacroPagination {
  limit: number;
  offset: number;
  total: number;
  hasMore: boolean;
}

type ListResolution<K extends WikiMacroKind> = {
  kind: K;
  data: unknown[];
  pagination: WikiMacroPagination;
  meta?: Record<string, unknown>;
};

export type WikiMacroResolution =
  | ListResolution<'blogPosts'>
  | ListResolution<'rssFeed'>
  | ListResolution<'pageTree'>
  | ListResolution<'attachmentsList'>
  | ListResolution<'recentlyUpdated'>
  | ListResolution<'pageTreeSearch'>
  | ListResolution<'changeHistory'>
  | {
      kind: 'spaceDetails';
      data: Record<string, unknown>;
      meta?: Record<string, unknown>;
    }
  | ListResolution<'userList'>
  | {
      kind: 'userProfile';
      data: Record<string, unknown>;
      meta?: Record<string, unknown>;
    }
  | {
      kind: 'profilePicture';
      data: Record<string, unknown>;
      meta?: Record<string, unknown>;
    }
  | ListResolution<'popularLabels'>
  | ListResolution<'recentlyUsedLabels'>
  | ListResolution<'relatedLabels'>
  | ListResolution<'contentByUser'>
  | ListResolution<'recentlyUpdatedDashboard'>
  | ListResolution<'contentReportTable'>
  | ListResolution<'decisionReport'>
  | ListResolution<'navigationMap'>;
