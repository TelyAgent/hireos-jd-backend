import { ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { Identity } from '../auth/workspace.guard';

type CoreRoleVersion = {
  id: string;
  jobId: string;
  versionNo: number;
  status: string;
  roleSummary?: string;
  responsibilities: unknown[];
  requirements: unknown[];
  dimensions: unknown[];
  evaluationReadiness?: string;
  confirmedBy?: string;
  confirmedAt?: string;
};

export type CoreJob = {
  id: string;
  workspaceId: string;
  title: string;
  team?: string;
  location?: string;
  employmentType?: string;
  seniority?: string;
  status: string;
  openings: number;
  version: number;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
};

@Injectable()
export class CoreRecordClient {
  private readonly baseUrl: string;
  private readonly serviceName: string;

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string>('CORE_RECORD_BASE_URL', 'http://127.0.0.1:3004/api/v1').replace(/\/$/, '');
    this.serviceName = config.get<string>('CORE_RECORD_SERVICE_NAME', 'jd');
  }

  async createJob(identity: Identity, body: unknown, idempotencyKey: string) {
    return this.request<CoreJob>('/jobs', identity, 'POST', body, idempotencyKey);
  }

  async listJobs(identity: Identity, q?: string) {
    const query = q?.trim() ? `?q=${encodeURIComponent(q.trim())}` : '';
    return this.request<CoreJob[]>(`/jobs${query}`, identity, 'GET');
  }

  async getJob(identity: Identity, jobId: string) {
    return this.request<CoreJob>(`/jobs/${jobId}`, identity, 'GET');
  }

  async deleteJob(identity: Identity, jobId: string, idempotencyKey: string) {
    return this.request<{ id: string; deleted: boolean }>(`/jobs/${jobId}`, identity, 'DELETE', undefined, idempotencyKey);
  }

  async createRoleVersion(identity: Identity, jobId: string, body: unknown, idempotencyKey: string) {
    return this.request<CoreRoleVersion>(`/jobs/${jobId}/role-versions`, identity, 'POST', body, idempotencyKey);
  }

  async getRoleVersion(identity: Identity, jobId: string, roleVersionId: string) {
    return this.request<CoreRoleVersion>(`/jobs/${jobId}/role-versions/${roleVersionId}`, identity, 'GET');
  }

  async updateRoleVersion(identity: Identity, jobId: string, roleVersionId: string, body: unknown, idempotencyKey: string) {
    return this.request<CoreRoleVersion>(`/jobs/${jobId}/role-versions/${roleVersionId}`, identity, 'PATCH', body, idempotencyKey);
  }

  async confirmRoleVersion(identity: Identity, jobId: string, roleVersionId: string, body: unknown, idempotencyKey: string) {
    return this.request<CoreRoleVersion>(`/jobs/${jobId}/role-versions/${roleVersionId}/confirm`, identity, 'POST', body, idempotencyKey);
  }

  private async request<T>(path: string, identity: Identity, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', body?: unknown, idempotencyKey?: string) {
    const response = await globalThis.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-request-id': randomUUID(),
        'x-correlation-id': `${this.serviceName}:${randomUUID()}`,
        'x-source-service': this.serviceName,
        'x-workspace-id': identity.workspaceId,
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = result as { code?: string; message?: string };
      if (response.status === 409) throw new ConflictException({ code: error.code || 'CORE_RECORD_CONFLICT', message: error.message });
      if (response.status === 404) throw new NotFoundException({ code: error.code || 'CORE_RECORD_NOT_FOUND', message: error.message });
      throw new ServiceUnavailableException({ code: error.code || 'CORE_RECORD_UNAVAILABLE', message: error.message });
    }
    return result as T;
  }
}
