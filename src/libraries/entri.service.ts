import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class EntriService {
  private readonly logger = new Logger(EntriService.name);
  private readonly applicationId: string;
  private readonly secret: string;
  private readonly baseUrl = 'https://api.goentri.com';

  constructor() {
    this.applicationId =
      process.env.ENTRI_APPLICATION_ID || 'reply_agent';
    this.secret =
      process.env.ENTRI_SECRET ||
      'a4611a0d8a8b0605f96ba40c8f12e2c16672d5d8c60eac771df61a6228e77b60';
  }

  async getToken(): Promise<string | null> {
    try {
      const response = await axios.post(`${this.baseUrl}/token`, {
        applicationId: this.applicationId,
        secret: this.secret,
      });

      return response.data?.auth_token || null;
    } catch (error) {
      this.logger.error(`Entri getToken failed: ${error.message}`);
      return null;
    }
  }

  async deletePowerDomain(domain: string): Promise<boolean> {
    const token = await this.getToken();
    if (!token) {
      throw new InternalServerErrorException('Failed to get Entri token');
    }

    try {
      await axios.delete(`${this.baseUrl}/power`, {
        headers: {
          Authorization: token,
          applicationId: this.applicationId,
        },
        data: { domain },
      });
      return true;
    } catch (error) {
      const message =
        error?.response?.data?.message ||
        error.message ||
        'Failed to delete Entri domain';
      this.logger.error(`Entri deletePowerDomain failed: ${message}`);
      throw new InternalServerErrorException(message);
    }
  }
}
