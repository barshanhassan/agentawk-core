import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { generateSecret, verify, generateURI } from 'otplib';

@Injectable()
export class AuthService {
  constructor(
    private jwtService: JwtService,
    private prisma: PrismaService,
  ) {}

  async login(userDto: any, domainInfo: any, hostname: string = '') {
    console.log(`Login attempt for email: "${userDto.email}"`);

    // Tenant-scoped lookup: if the request arrived on a registered tenant subdomain
    // (domainInfo carries modelable_*), require the user to belong to that exact
    // workspace/agency. This mirrors the PHP gateway's Auth::attempt + modelable filter,
    // and prevents an agency-only user from logging into a workspace subdomain (or vice
    // versa). On the "central" dev hosts (web.app/run.app/localhost without a tenant
    // subdomain), fall back to email-only so the original behaviour is preserved.
    const isCentral =
      !hostname.includes('agency.localhost') &&
      (hostname.includes('web.app') ||
        hostname.includes('localhost') ||
        hostname.includes('run.app'));
    const useTenantScope =
      !isCentral && !!domainInfo?.modelable_id && !!domainInfo?.modelable_type;

    const baseWhere: any = { email: userDto.email, status: 'ACTIVE' };
    if (useTenantScope) {
      baseWhere.modelable_id = domainInfo.modelable_id;
      baseWhere.modelable_type = domainInfo.modelable_type;
    }

    const user = await this.prisma.users.findFirst({ where: baseWhere });
    console.log(`User found? ${!!user} (tenantScope=${useTenantScope})`);

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isMatched = await bcrypt.compare(
      userDto.password,
      user.password || '',
    );
    if (!isMatched) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Smart Role detection based on database (Case-insensitive check)
    const isAgency = user.modelable_type.toLowerCase().includes('agency');
    const userRole = isAgency ? 'AGENCY' : 'WORKSPACE';

    // Context derives from the tenant subdomain when available; otherwise from the
    // user's own modelable. isCentral / useTenantScope are computed above for the
    // user-lookup filter.
    const contextType =
      domainInfo?.modelable_type && !isCentral
        ? domainInfo.modelable_type
        : user.modelable_type;
    const contextId =
      domainInfo?.modelable_id && !isCentral
        ? domainInfo.modelable_id
        : user.modelable_id;

    // Capture the login event. Workspace-context logins go into audit_logs
    // (workspace-scoped); agency-context logins go into agency_logs so the
    // Agency Logs UI shows them under the agent filter.
    const isWorkspaceContext = contextType.toLowerCase().includes('workspace');
    if (isWorkspaceContext) {
      await this.prisma.audit_logs.create({
        data: {
          workspace_id: contextId,
          user_id: user.id,
          modelable_type: contextType,
          modelable_id: contextId,
          event: 'user_logged_in',
          data: JSON.stringify({ ip: 'mock-ip', via_central: isCentral }),
          created_at: new Date(),
          updated_at: new Date(),
        },
      });
    } else {
      // Agency-context login → agency_logs. Use the agency id (= contextId).
      await this.prisma.agency_logs.create({
        data: {
          agency_id: contextId,
          user_id: user.id,
          modelable_type: contextType,
          modelable_id: contextId,
          event: 'user_logged_in',
          data: JSON.stringify({ ip: 'mock-ip', via_central: isCentral }),
          created_at: new Date(),
          updated_at: new Date(),
        },
      });
    }

    const redirectTo = isAgency ? '/agency' : '/workspace';

    // Load user's permissions from their assigned role
    const permissions = await this.loadUserPermissions(user.id);

    // JWT token generation
    const payload = {
      email: user.email,
      sub: user.id.toString(),
      modelable_id: contextId.toString(),
      modelable_type: contextType,
      role: userRole,
      tfa_enabled: user.tfa_enabled,
      workspace_id: contextType.toLowerCase().includes('workspace')
        ? contextId.toString()
        : null,
      permissions,
    };

    const expiresIn = userDto.remember ? '30d' : '12h';

    return {
      user: {
        id: user.id.toString(),
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        tfa_enabled: user.tfa_enabled,
        role: userRole,
        modelable_id: contextId.toString(),
        modelable_type: contextType,
      },
      token: this.jwtService.sign(payload, { expiresIn }),
      redirect_to: redirectTo,
    };
  }

  async register(userDto: any) {
    // Validation logic
    if (userDto.password !== userDto.re_password) {
      throw new BadRequestException('Passwords do not match');
    }

    const emailExists = await this.prisma.users.findFirst({
      where: { email: userDto.email, modelable_type: 'App\\Models\\Agency' },
    });

    if (emailExists) {
      throw new BadRequestException('Email already taken');
    }

    const saltOrRounds = 10;
    const hashedPassword = await bcrypt.hash(userDto.password, saltOrRounds);

    const agencyName = userDto.agencyName || `${userDto.firstName}'s Agency`;
    const baseSlug = this.slugify(agencyName);
    const agencySlug = `${baseSlug}-${Math.random().toString(36).substring(2, 7)}`;
    const subdomain = userDto.subdomain || agencySlug;

    // Transaction for all associated creation
    try {
      return await this.prisma.$transaction(async (tx) => {
        // 1. Create Agency
        const agency = await tx.agencies.create({
          data: {
            name: agencyName,
            slug: agencySlug,
            email: userDto.email,
            timezone: userDto.timezone || 'UTC',
            notification_language: userDto.locale || 'en-US',
            tax_id: userDto.tax_id || '',
            vat: userDto.vat || '',
            billing_company: agencyName,
            billing_person: `${userDto.firstName} ${userDto.lastName}`,
            status: 'ACTIVE',
          },
        });

        // 2. Create Address
        await tx.addresses.create({
          data: {
            addressable_type: 'App\\Models\\Agency',
            addressable_id: agency.id,
            street: userDto.address?.street || '',
            city: userDto.address?.city || '',
            state: userDto.address?.state || '',
            zip: userDto.address?.zip || '',
            country: userDto.address?.country || 'USA',
            country_iso2: 'US', // mock
          },
        });

        // 3. Billing Stub (Chargebee)
        // In production, you would call Chargebee API here and update agency.customer_id

        // 4. Create Domain
        const domain = await tx.domains.create({
          data: {
            modelable_type: 'App\\Models\\Agency', // Can be workspace in other contexts
            modelable_id: agency.id,
            sub_domain: subdomain,
            root_domain: process.env.ROOT_DOMAIN || 'ezconn.com',
            domain: `${subdomain}.${process.env.ROOT_DOMAIN || 'ezconn.com'}`,
            active: true,
            is_default: true,
          },
        });

        // 5. Create Mobile Contact for Agency
        await tx.contact_mobiles.create({
          data: {
            ownership_type: 'App\\Models\\Agency',
            ownership_id: agency.id,
            modelable_type: 'App\\Models\\Agency',
            modelable_id: agency.id,
            country_id: 231, // Defaulting to US code (as per Gateway usually)
            mobile_number: '5550100', // Mock
            national_mobile_number: '15550100',
            full_mobile_number: '+15550100',
          },
        });

        // 6. Create User

        const newUser = await tx.users.create({
          data: {
            first_name: userDto.firstName,
            last_name: userDto.lastName,
            email: userDto.email,
            password: hashedPassword,
            modelable_type: 'App\\Models\\Agency',
            modelable_id: agency.id,
            is_owner: true,
            status: 'ACTIVE',
            creator_id: BigInt(0),
            locale: userDto.locale || 'en-US',
          },
        });

        // 7. Default Workspace
        const workspace = await tx.workspaces.create({
          data: {
            name: 'Default Workspace',
            slug: this.slugify('Default Workspace' + agency.id.toString()),
            agency_id: agency.id,
            creator_id: newUser.id,
            status: 'ACTIVE',
            contacts_counter: 0,
          },
        });

        // 8. Legal terms acceptance snippet
        // await tx.agency_accepted_terms.create(...)

        return {
          error: false,
          message: 'Registration successful',
          error_code: 'CREATED',
          agency: {
            id: agency.id.toString(),
            name: agency.name,
          },
          redirect_url: `https://${domain.domain}/login`,
        };
      });
    } catch (error) {
      console.error(error);
      throw new InternalServerErrorException(
        'Registration failed: ' + error.message,
      );
    }
  }

  async makeTFA(userId: bigint) {
    const user = await this.prisma.users.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found');

    const secret = generateSecret();
    const otpauth = await generateURI({
      label: user.email,
      issuer: 'Ezconn Platform',
      secret,
    });

    await this.prisma.users.update({
      where: { id: userId },
      data: { tfa_code: secret, tfa_url: otpauth },
    });

    return { tfa_url: otpauth, tfa_code: secret };
  }

  async verifyTFA(userId: bigint, otp: string) {
    const user = await this.prisma.users.findUnique({ where: { id: userId } });
    if (!user || !user.tfa_code) throw new BadRequestException('TFA not setup');

    const isValid = await verify({ token: otp, secret: user.tfa_code });

    if (!isValid) {
      throw new BadRequestException('Invalid OTP');
    }

    if (!user.tfa_enabled) {
      await this.prisma.users.update({
        where: { id: userId },
        data: { tfa_enabled: true },
      });
    }

    return { message: 'Verified' };
  }

  async disableTFA(userId: bigint, password: string) {
    const user = await this.prisma.users.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found');

    const isPasswordValid = await bcrypt.compare(password, user.password || '');
    if (!isPasswordValid) throw new UnauthorizedException('Invalid password');

    await this.prisma.users.update({
      where: { id: userId },
      data: { tfa_enabled: false, tfa_code: '', tfa_url: '' },
    });

    return { message: 'TFA Disabled' };
  }

  async logout(userId: bigint) {
    // In a stateless JWT approach, logout usually involves blacklisting the token
    // or just letting the client drop it. For parity with Gateway "tokens()->delete()",
    // we log the event.
    console.log(
      `User ${userId} logged out (JWT token dropped by client or blacklisted)`,
    );
    return { user: null };
  }

  async initRegistration() {
    // Fetch system legal documents required for registration
    const firstTerm = await this.prisma.system_legal_documents.findFirst({
      where: { type: 'REGISTER1', status: 'ACTIVE' },
    });
    const secondTerm = await this.prisma.system_legal_documents.findFirst({
      where: { type: 'REGISTER2', status: 'ACTIVE' },
    });
    const thirdTerm = await this.prisma.system_legal_documents.findFirst({
      where: { type: 'REGISTER3', status: 'ACTIVE' },
    });

    return {
      first_term: firstTerm,
      second_term: secondTerm,
      third_term: thirdTerm,
    };
  }

  async validateInvitation(invitationId: string) {
    // In Gateway this uses Crypt::decrypt. Assuming invitationId is the raw ID for now or decoded.
    // We'll treat it as a decode stub.
    let userId: bigint;
    try {
      // Stub: assuming it's base64 encoded or just raw ID
      userId = BigInt(atob(invitationId));
    } catch (e) {
      userId = BigInt(invitationId); // fallback if it's just raw numeric
    }

    const user = await this.prisma.users.findFirst({
      where: {
        id: userId,
        status: 'PENDING',
      },
    });

    if (!user) {
      throw new BadRequestException(
        'Invalid invitation code or already accepted',
      );
    }

    // Fetch Legal documents for the specific modelable
    const firstTerm = await this.prisma.legal_documents.findFirst({
      where: {
        modelable_id: user.modelable_id,
        modelable_type: user.modelable_type,
        type: 'CHECKBOX1',
        status: 'ACTIVE',
      },
    });

    const secondTerm = await this.prisma.legal_documents.findFirst({
      where: {
        modelable_id: user.modelable_id,
        modelable_type: user.modelable_type,
        type: 'CHECKBOX2',
        status: 'ACTIVE',
      },
    });

    return {
      error: false,
      member: {
        id: user.id.toString(),
        email: user.email,
        first_name: user.first_name,
      },
      first_term: firstTerm,
      second_term: secondTerm,
    };
  }

  async acceptInvitation(data: any) {
    let userId: bigint;
    try {
      userId = BigInt(atob(data.invitation_id));
    } catch (e) {
      userId = BigInt(data.invitation_id);
    }

    const user = await this.prisma.users.findFirst({
      where: { id: userId, status: 'PENDING' },
    });

    if (!user) throw new BadRequestException('Invalid invitation code');

    if (data.password !== data.re_password) {
      throw new BadRequestException('Passwords do not match');
    }

    const hashedPassword = await bcrypt.hash(data.password, 10);

    await this.prisma.users.update({
      where: { id: userId },
      data: {
        first_name: data.first_name,
        last_name: data.last_name,
        password: hashedPassword,
        status: 'ACTIVE',
        email_verified_at: new Date(),
      },
    });

    // Gateway clears caches and logs terms acceptance here. Stubbing for brevity.

    return {
      error: false,
      message: 'Invitation accepted successfully',
      redirect_to: '/login',
    };
  }

  async verifyMobile(userId: bigint, mobile: string, code?: string) {
    // Implementation mirroring Gateway verifyMobile logic using Twilio
    if (!code) {
      // "GET" - Sending OTP Phase
      // In a real app we'd initiate Twilio verify service here
      console.log(`Sending Twilio OTP stub to ${mobile}`);
      return { success: true, otp: { status: 'pending' } };
    } else {
      // "POST" - Verifying OTP Phase
      console.log(`Verifying Twilio OTP stub for ${mobile} with code ${code}`);
      const isVerified = code === '123456'; // Stub success logic
      return { verified: isVerified };
    }
  }

  async verifyEmail(
    userId: bigint,
    email: string,
    code?: string,
    domainInfo?: any,
  ) {
    const user = await this.prisma.users.findUnique({ where: { id: userId } });
    if (!code) {
      // Sending verification code
      const emailExists = await this.prisma.users.findFirst({
        where: {
          email,
          modelable_id: domainInfo.modelable_id,
          modelable_type: domainInfo.modelable_type,
        },
      });
      if (emailExists) throw new BadRequestException('Email already taken');

      const verificationCode = Math.floor(
        1000 + Math.random() * 9000,
      ).toString(); // 4-digit code

      // Note: Since Prisma schema for users doesn't seem to have `email_verification_code`
      // from the Gateway schema output earlier, we'd log or throw an unsupported stub here.
      // For now, we stub dispatch.
      console.log(
        `Stub: Dispatched Email Code ${verificationCode} to ${email}`,
      );

      return { success: true };
    } else {
      // Verify phase (assuming code was stored somewhere, e.g cache or db)
      // Stubbed verification logic
      const isVerified = code === '1234';
      if (isVerified) {
        await this.prisma.users.update({
          where: { id: userId },
          data: { email },
        });
      }
      return { verified: isVerified };
    }
  }

  async findAccount(email: string) {
    // Find if user account exists on the platform
    const user = await this.prisma.users.findFirst({
      where: {
        email,
        modelable_type: 'App\\Models\\Agency',
        status: 'ACTIVE',
      },
    });

    if (user) {
      console.log(`Stub: SendAccountFound Email dispatched to ${email}`);
    }

    return { success: true };
  }

  async forgotPassword(email: string, domainInfo: any) {
    const user = await this.prisma.users.findFirst({
      where: {
        email,
        modelable_id: domainInfo.modelable_id,
        modelable_type: domainInfo.modelable_type,
        status: 'ACTIVE',
      },
    });

    if (!user) {
      throw new BadRequestException('Email does not exist or account inactive');
    }

    /* 
        if (user.agency_user_id) {
            throw new BadRequestException('Reset not allowed for agency users directly'); 
        } 
        */

    // Generate 6 character code like Gateway randomKey("character", 6)
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();

    await this.prisma.password_resets.create({
      data: {
        email,
        token: code,
        created_at: new Date(),
      },
    });

    // 📧 In production: SendResetPasswordEmail::dispatch($user->id, $code);
    // Stub for now

    return {
      message: 'Password reset email sent',
      code: 'EMAIL_SENT',
      debugCode: code,
    };
  }

  async resetPassword(data: any, domainInfo: any) {
    const resetRecord = await this.prisma.password_resets.findFirst({
      where: {
        email: data.email,
        token: data.code.toUpperCase(),
      },
      orderBy: { created_at: 'desc' },
    });

    if (!resetRecord) {
      throw new BadRequestException('Invalid or expired code');
    }

    const user = await this.prisma.users.findFirst({
      where: {
        email: data.email,
        modelable_id: domainInfo.modelable_id,
        modelable_type: domainInfo.modelable_type,
        status: 'ACTIVE',
      },
    });

    if (!user) {
      throw new BadRequestException('User not found');
    }

    if (data.new_password !== data.confirm_password) {
      throw new BadRequestException('Passwords do not match');
    }

    const hashedPassword = await bcrypt.hash(data.new_password, 10);

    await this.prisma.users.update({
      where: { id: user.id },
      data: { password: hashedPassword },
    });

    // Delete used token
    await this.prisma.password_resets.deleteMany({
      where: { email: data.email }, // Clears all tokens for this email
    });

    return { message: 'Password updated successfully', code: 'SUCCESS' };
  }

  async changePassword(userId: bigint, data: any) {
    if (data.new_password !== data.confirm_password) {
      throw new BadRequestException('New passwords do not match');
    }

    const user = await this.prisma.users.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found');

    const isPasswordValid = await bcrypt.compare(
      data.old_password,
      user.password || '',
    );
    if (!isPasswordValid)
      throw new UnauthorizedException('Incorrect old password');

    const hashedPassword = await bcrypt.hash(data.new_password, 10);

    await this.prisma.users.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });

    return { message: 'Password updated successfully' };
  }

  async loadUserPermissions(userId: bigint): Promise<string[]> {
    // Owner gets wildcard — all permissions granted
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { is_owner: true },
    });
    if (user?.is_owner) return ['agency.*', 'workspace.*'];

    const roleable = await this.prisma.acl_roleables.findFirst({
      where: { roleable_id: userId, roleable_type: 'App\\Models\\User' },
    });

    const slugs: string[] = [];

    if (roleable) {
      const rolePerms = await this.prisma.acl_role_permissions.findMany({
        where: { role_id: roleable.role_id },
      });
      if (rolePerms.length > 0) {
        const perms = await this.prisma.acl_permissions.findMany({
          where: { id: { in: rolePerms.map((rp) => rp.permission_id) } },
          select: { slug: true },
        });
        slugs.push(...perms.map((p) => p.slug));
      }
    }

    // Direct entity permissions (without role)
    const entityPerms = await this.prisma.acl_entity_permissions.findMany({
      where: { entity_id: userId, entity_type: 'App\\Models\\User' },
    });
    if (entityPerms.length > 0) {
      const perms = await this.prisma.acl_permissions.findMany({
        where: { id: { in: entityPerms.map((ep) => ep.permission_id) } },
        select: { slug: true },
      });
      slugs.push(...perms.map((p) => p.slug));
    }

    return [...new Set(slugs)];
  }

  private slugify(text: string): string {
    return text
      .toString()
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^\w-]+/g, '')
      .replace(/--+/g, '-');
  }
}
