import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '../mail/mailer.service';
import { generateSecret, verify, generateURI } from 'otplib';

@Injectable()
export class AuthService {
  constructor(
    private jwtService: JwtService,
    private prisma: PrismaService,
    private readonly mailer: MailerService,
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
        hostname.includes('vercel.app') ||
        hostname.includes('localhost') ||
        hostname.includes('run.app'));
    const useTenantScope =
      !isCentral && !!domainInfo?.modelable_id && !!domainInfo?.modelable_type;

    // Neither a recognized dev/central host nor a registered tenant subdomain
    // (e.g. the public app.agentawk.com / agentawk.com marketing host) — refuse
    // rather than silently falling back to an unscoped, email-only lookup that
    // would let any account log in from a host that isn't theirs.
    if (!isCentral && !useTenantScope) {
      throw new UnauthorizedException(
        'Please log in using your workspace login URL — the link emailed to you when your account was created.',
      );
    }

    const baseWhere: any = { email: userDto.email, status: 'ACTIVE' };
    if (useTenantScope) {
      baseWhere.modelable_id = domainInfo.modelable_id;
      baseWhere.modelable_type = domainInfo.modelable_type;
    }

    // A single email can map to multiple user rows — the same person across an
    // agency + its workspaces, or (on a shared/central host doing email-only
    // lookup) even unrelated accounts that happen to reuse the email. Fetch all
    // candidates and pick the one whose password actually verifies, instead of
    // blindly taking findFirst (which could land on a different account whose
    // password won't match → a false "Invalid credentials").
    const candidates = await this.prisma.users.findMany({
      where: baseWhere,
      orderBy: { id: 'asc' },
    });
    console.log(
      `Candidates found: ${candidates.length} (tenantScope=${useTenantScope})`,
    );

    let user: any = null;
    for (const candidate of candidates) {
      if (await bcrypt.compare(userDto.password, candidate.password || '')) {
        user = candidate;
        break;
      }
    }

    if (!user) {
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
    // Build the login-event log write (workspace-context → audit_logs;
    // agency-context → agency_logs). Not awaited on its own — it runs in parallel
    // with the permission load below to cut total login latency.
    const isWorkspaceContext = contextType.toLowerCase().includes('workspace');
    const logWrite = isWorkspaceContext
      ? this.prisma.audit_logs.create({
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
        })
      : this.prisma.agency_logs.create({
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

    // "/org" is the organization (formerly agency) dashboard route on the
    // frontend; old "/agency" URLs are redirected client-side.
    const redirectTo = isAgency ? '/org' : '/workspace';

    // Run the log write and permission load concurrently (pass is_owner so the
    // loader skips a redundant users query) — fewer serial DB round-trips.
    const [, permissions] = await Promise.all([
      logWrite,
      this.loadUserPermissions(user.id, user.is_owner),
    ]);

    // JWT token generation
    const payload = {
      email: user.email,
      sub: user.id.toString(),
      // Kept in sync with loginToWorkspace()'s payload — GET /auth/au (used
      // by the cross-subdomain SSO handoff) has no DB access and just echoes
      // this token back, so name fields must live here too.
      first_name: user.first_name,
      last_name: user.last_name,
      modelable_id: contextId.toString(),
      modelable_type: contextType,
      role: userRole,
      tfa_enabled: user.tfa_enabled,
      // Owners (is_owner) implicitly hold 'agency.*'/'workspace.*' (see
      // loadUserPermissions). Surfacing the flag lets the UI grant owner
      // affordances without re-deriving it from the wildcard slugs.
      is_owner: user.is_owner,
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
        is_owner: user.is_owner,
        modelable_id: contextId.toString(),
        modelable_type: contextType,
      },
      token: this.jwtService.sign(payload, { expiresIn }),
      redirect_to: redirectTo,
    };
  }

  /**
   * Signup email OTP — 4-digit numeric code stored in `otp_codes` (key=email),
   * mirroring the replyagent-backend OtpCode::getCode pattern this was modeled on.
   */
  private async sendSignupOtp(email: string): Promise<{ sent: boolean; debugCode?: string }> {
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    const expiry = new Date(Date.now() + 15 * 60 * 1000);

    // No unique constraint on `key` — clear any previous code first so
    // verifySignupOtp always matches against the latest one sent.
    await this.prisma.otp_codes.deleteMany({ where: { key: email } });
    await this.prisma.otp_codes.create({ data: { key: email, code, expiry } });

    const mailResult = await this.mailer.sendMail({
      to: email,
      subject: 'Verify your AGENTAWK account',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto">
          <h2 style="color:#4f46e5">Welcome to AGENTAWK</h2>
          <p>Use the code below to verify your email and activate your account. It is valid for 15 minutes.</p>
          <p style="font-size:32px;font-weight:bold;letter-spacing:10px;background:#f3f4f6;padding:14px 20px;border-radius:10px;text-align:center">${code}</p>
          <p style="color:#888;font-size:12px">If you didn't create an AGENTAWK account, you can ignore this email.</p>
        </div>`,
      text: `Your AGENTAWK verification code is: ${code}`,
    });

    return { sent: mailResult.sent, debugCode: code };
  }

  /**
   * "Login" button on an Agency Manager's workspace card — issues a fresh
   * workspace-scoped token for the CURRENTLY authenticated agency manager,
   * without asking for a password again.
   *
   * Security: workspaces sharing the same name ("Default Workspace") across
   * different agencies must never be confused — this always resolves by the
   * numeric workspaceId and hard-checks workspace.agency_id against the
   * caller's own agency (modelable_id from their JWT), never by name.
   */
  async loginToWorkspace(agencyUserId: bigint, agencyModelableId: bigint, workspaceId: bigint) {
    const workspace = await this.prisma.workspaces.findUnique({
      where: { id: workspaceId },
      select: { id: true, agency_id: true, name: true, status: true, agency_agent_id: true },
    });
    if (!workspace) throw new BadRequestException('Workspace not found');

    // Tenant check — this agency manager may only enter workspaces that
    // belong to THEIR OWN agency, regardless of workspace name collisions.
    if (workspace.agency_id !== agencyModelableId) {
      throw new UnauthorizedException('This workspace does not belong to your agency');
    }
    if (workspace.status !== 'ACTIVE') {
      throw new BadRequestException('Workspace is not active');
    }

    const agencyUser = await this.prisma.users.findUnique({ where: { id: agencyUserId } });
    if (!agencyUser) throw new UnauthorizedException('Invalid session');

    // The workspace lives on its OWN subdomain. Resolved up front — both the
    // JIT-provision path and the "go log in yourself" path below need it.
    const wsDomain = await this.prisma.domains.findFirst({
      where: {
        modelable_id: workspace.id,
        modelable_type: 'App\\Models\\Workspace',
      },
      orderBy: [{ active: 'desc' }, { is_default: 'desc' }, { id: 'desc' }],
    });
    const workspaceUrl = wsDomain?.domain ? this.buildTenantUrl(wsDomain.domain) : null;

    let workspaceUser = await this.prisma.users.findFirst({
      where: {
        email: agencyUser.email,
        modelable_type: 'App\\Models\\Workspace',
        modelable_id: workspace.id,
        status: 'ACTIVE',
      },
    });
    if (!workspaceUser) {
      // A workspace with its OWN dedicated agent (someone other than the
      // caller) belongs to that person, not to whoever clicked "Login" in
      // the agency dashboard — don't silently enter under the caller's own
      // identity. Send them to that workspace's real login page instead.
      // Only workspaces with NO assigned agent (Default Workspace) or ones
      // the caller themselves is the assigned agent for get JIT-provisioned.
      const hasOtherAgent =
        workspace.agency_agent_id != null && workspace.agency_agent_id !== agencyUserId;
      if (hasOtherAgent) {
        return { requires_login: true, workspace_url: workspaceUrl };
      }

      // JIT-provision — this endpoint's whole point is letting any agency
      // manager enter a workspace under their own agency without a password
      // (see the class doc above). That row only ever got created for the
      // signup-time Default Workspace or an explicitly-assigned agent, so
      // every other workspace threw "No active login found" here even
      // though the tenant check above already confirmed access is allowed.
      // Provisioned ACTIVE immediately (no invite/password step) since the
      // caller is already an authenticated agency user.
      workspaceUser = await this.prisma.users.create({
        data: {
          first_name: agencyUser.first_name,
          last_name: agencyUser.last_name,
          email: agencyUser.email,
          password: agencyUser.password,
          modelable_type: 'App\\Models\\Workspace',
          modelable_id: workspace.id,
          is_owner: agencyUser.is_owner,
          status: 'ACTIVE',
          creator_id: agencyUser.id,
          active_workspace_id: workspace.id,
          locale: agencyUser.locale || 'en-US',
        },
      });
    }

    const permissions = await this.loadUserPermissions(workspaceUser.id, workspaceUser.is_owner);
    const payload = {
      email: workspaceUser.email,
      sub: workspaceUser.id.toString(),
      // The SSO handoff (SsoHandoffPage → GET /auth/au) has no DB access —
      // it just echoes back whatever's in this token, so name fields must
      // travel here too or the workspace topbar shows "undefined".
      first_name: workspaceUser.first_name,
      last_name: workspaceUser.last_name,
      modelable_id: workspace.id.toString(),
      modelable_type: 'App\\Models\\Workspace',
      role: 'WORKSPACE',
      tfa_enabled: workspaceUser.tfa_enabled,
      is_owner: workspaceUser.is_owner,
      workspace_id: workspace.id.toString(),
      permissions,
    };

    return {
      user: {
        id: workspaceUser.id.toString(),
        email: workspaceUser.email,
        first_name: workspaceUser.first_name,
        last_name: workspaceUser.last_name,
        tfa_enabled: workspaceUser.tfa_enabled,
        role: 'WORKSPACE',
        is_owner: workspaceUser.is_owner,
        modelable_id: workspace.id.toString(),
        modelable_type: 'App\\Models\\Workspace',
      },
      token: this.jwtService.sign(payload, { expiresIn: '12h' }),
      // Full URL to the workspace's own subdomain (null if it has no domain yet
      // — e.g. legacy default workspaces created before subdomains were added).
      workspace_url: workspaceUrl,
      redirect_to: '/workspace',
    };
  }

  /**
   * Retry a DB operation that fails with a TRANSIENT connection/transaction
   * error. Observed symptom: the first attempt fails with "Transaction not
   * found ... obtained before disconnecting" and the immediate retry succeeds —
   * a stale pooled connection the remote DB had already closed while idle.
   * Prisma discards the dead connection on error, so simply re-running the
   * operation picks up a healthy one. This is NOT a timeout problem.
   */
  private async runWithDbRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
    let lastErr: any;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        lastErr = err;
        const msg = String(err?.message ?? err);
        const transient =
          err?.code === 'P1017' || // "Server has closed the connection"
          err?.code === 'P2028' || // transaction API error
          /transaction (not found|api error)|closed the connection|connection.*(closed|reset)|before disconnecting/i.test(
            msg,
          );
        if (!transient || attempt === retries) throw err;
        // Brief backoff; the next attempt gets a fresh connection from the pool.
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  async register(userDto: any) {
    // No password field anymore — the user sets nothing at signup. A random
    // password is generated and emailed (with the login URL + username) once
    // they verify their email via sendSignupOtp/verifySignupOtp below.
    const emailExists = await this.prisma.users.findFirst({
      where: { email: userDto.email, modelable_type: 'App\\Models\\Agency' },
    });

    if (emailExists && emailExists.status === 'ACTIVE') {
      throw new BadRequestException('Email already taken');
    }

    if (emailExists && emailExists.status === 'PENDING') {
      // A previous signup never finished verification — resend a fresh code
      // instead of creating a duplicate agency for the same email.
      const resent = await this.sendSignupOtp(userDto.email);
      return {
        error: false,
        message: 'Verification code resent',
        error_code: 'OTP_RESENT',
        email: userDto.email,
        emailSent: resent.sent,
        debugCode: resent.debugCode,
      };
    }

    const agencyName = userDto.agencyName || `${userDto.firstName}'s Agency`;
    const baseSlug = this.slugify(agencyName);
    const agencySlug = `${baseSlug}-${Math.random().toString(36).substring(2, 7)}`;
    const subdomain = userDto.subdomain || agencySlug;

    // Transaction for all associated creation. Wrapped in runWithDbRetry so a
    // stale pooled connection (remote DB closed it while idle) doesn't fail the
    // whole signup — the failed transaction rolls back and re-runs on a fresh
    // connection, which is why the 2nd attempt always worked.
    try {
      const result = await this.runWithDbRetry(() =>
        this.prisma.$transaction(async (tx) => {
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

        // 3. Free plan subscription — every agency needs a real
        // billing_subscriptions row from the start so plan-limit enforcement
        // (createWorkspace, contacts, etc.) has something to check against.
        // Without this, "Free" was only a cosmetic UI fallback label and
        // nothing was actually enforced. Missing free-plan seed data isn't
        // fatal to signup — an agency without a subscription row still just
        // falls back to unlimited, same as before this change.
        const freePlan = await tx.billing_plans.findFirst({ where: { item_id: 'free-plan' } });
        if (freePlan) {
          await tx.billing_subscriptions.create({
            data: {
              agency_id: agency.id,
              subscription_id: `free-${agency.id}`,
              customer_id: `agency-${agency.id}`,
              billing_plan_id: freePlan.id,
              default: true,
              status: 'active',
              activated_at: new Date(),
              started_at: new Date(),
              created_at: new Date(),
              updated_at: new Date(),
            },
          });
        }

        // 4. Create Domain
        const domain = await tx.domains.create({
          data: {
            modelable_type: 'App\\Models\\Agency', // Can be workspace in other contexts
            modelable_id: agency.id,
            sub_domain: subdomain,
            root_domain: process.env.ROOT_DOMAIN || 'agentawk.com',
            domain: `${subdomain}.${process.env.ROOT_DOMAIN || 'agentawk.com'}`,
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
            // No password yet — generated + emailed once verifySignupOtp succeeds.
            password: '',
            modelable_type: 'App\\Models\\Agency',
            modelable_id: agency.id,
            is_owner: true,
            // PENDING until the signup email OTP is verified (see sendSignupOtp
            // below) — login only ever matches status: 'ACTIVE' (see login()).
            status: 'PENDING',
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

        // 7a. Default workspace gets its OWN subdomain (like manually-created
        // workspaces do via addCustomDomain). Without this the default workspace
        // had no domain, so "login to workspace" fell back to the agency
        // subdomain instead of opening the workspace on its own URL. The slug
        // embeds agency.id, so the resulting domain is unique.
        await tx.domains.create({
          data: {
            modelable_type: 'App\\Models\\Workspace',
            modelable_id: workspace.id,
            sub_domain: workspace.slug,
            root_domain: process.env.ROOT_DOMAIN || 'agentawk.com',
            domain: `${workspace.slug}.${process.env.ROOT_DOMAIN || 'agentawk.com'}`,
            active: true,
            is_default: true,
          },
        });

        // 7b. Matching workspace-scoped login for the same person (same email,
        // same generated password as the agency user above once verified).
        // PENDING like the agency user — verifySignupOtp activates both rows
        // together on the same OTP.
        await tx.users.create({
          data: {
            first_name: userDto.firstName,
            last_name: userDto.lastName,
            email: userDto.email,
            password: '',
            modelable_type: 'App\\Models\\Workspace',
            modelable_id: workspace.id,
            is_owner: true,
            status: 'PENDING',
            creator_id: newUser.id,
            active_workspace_id: workspace.id,
            locale: userDto.locale || 'en-US',
          },
        });

        // 8. Legal terms acceptance snippet
        // await tx.agency_accepted_terms.create(...)

        return { agency, domain };
      },
      {
        // Defensive headroom for the remote DB. The real intermittent failure
        // ("Transaction not found ... obtained before disconnecting", which
        // works on retry) is a stale pooled connection — handled by
        // runWithDbRetry above, not by these timeouts.
        maxWait: 15000,
        timeout: 30000,
      }));

      const otpResult = await this.sendSignupOtp(userDto.email);

      return {
        error: false,
        message: 'Verification code sent to your email',
        error_code: 'OTP_SENT',
        agency: {
          id: result.agency.id.toString(),
          name: result.agency.name,
        },
        email: userDto.email,
        emailSent: otpResult.sent,
        // debugCode stays so dev/testing works even before SMTP is configured.
        debugCode: otpResult.debugCode,
        redirect_url: `https://${result.domain.domain}/login`,
      };
    } catch (error) {
      console.error(error);
      throw new InternalServerErrorException(
        'Registration failed: ' + (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  async makeTFA(userId: bigint) {
    const user = await this.prisma.users.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found');

    const secret = generateSecret();
    const otpauth = await generateURI({
      label: user.email,
      issuer: 'Agentawk Platform',
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

  /**
   * Builds a tenant subdomain's full URL. Both local and production serve
   * HTTPS (local via vite-plugin-basic-ssl's self-signed cert) — the only
   * difference is the port: production has none (nginx fronts it on 443),
   * while local Vite serves on a specific port that doesn't appear in
   * `domain` at all, so links generated here (find-account emails,
   * workspace-login handoff) would otherwise connection-refuse/empty-response
   * locally. LOCAL_FRONTEND_PORT lets local testing supply that port;
   * production should never set it.
   */
  private buildTenantUrl(domain: string): string {
    // domains.domain isn't consistently stored bare — DomainsService.addCustomDomain
    // bakes in its own http://(dev)/https://(prod) prefix, while the signup flow
    // stores a bare hostname. Strip whatever's there so this never double-prefixes
    // into "https://http://...", which the browser can't resolve.
    const bareDomain = domain.replace(/^https?:\/\//, '');
    const port = process.env.NODE_ENV === 'production' ? '' : `:${process.env.LOCAL_FRONTEND_PORT || '5173'}`;
    return `https://${bareDomain}${port}`;
  }

  async findAccount(email: string) {
    // "Find my account" — used on the central app.agentawk.com host where the
    // user has no tenant subdomain yet. We email every login URL tied to this
    // address (the agency AND each workspace it belongs to). Anti-enumeration:
    // we ALWAYS return the same success shape, so a caller can't probe which
    // emails exist. The email is best-effort — sent only if rows are found.
    const users = await this.prisma.users.findMany({
      where: { email, status: 'ACTIVE' },
      orderBy: { id: 'asc' },
    });

    if (users.length) {
      const links: { label: string; url: string }[] = [];
      const seen = new Set<string>();

      for (const u of users) {
        // Each tenant's active/default domain (fall back to the latest row).
        const domain = await this.prisma.domains.findFirst({
          where: {
            modelable_id: u.modelable_id,
            modelable_type: u.modelable_type,
          },
          orderBy: [{ active: 'desc' }, { is_default: 'desc' }, { id: 'desc' }],
        });
        if (!domain?.domain) continue;

        const isAgency = u.modelable_type.toLowerCase().includes('agency');
        // Name is best-effort — a nice label in the email, not critical.
        let name = isAgency ? 'Organization' : 'Workspace';
        try {
          if (isAgency) {
            const a = await this.prisma.agencies.findUnique({
              where: { id: u.modelable_id },
            });
            if (a?.name) name = a.name;
          } else {
            const w = await this.prisma.workspaces.findUnique({
              where: { id: u.modelable_id },
            });
            if (w?.name) name = w.name;
          }
        } catch {
          /* label falls back to the generic name above */
        }

        const url = `${this.buildTenantUrl(domain.domain)}/login`;
        const key = url.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({
          label: `${name} (${isAgency ? 'Organization' : 'Workspace'})`,
          url,
        });
      }

      if (links.length) {
        const rows = links
          .map(
            (l) =>
              `<tr><td style="padding:6px 10px;color:#666;font-size:13px">${l.label}</td><td style="padding:6px 10px;font-weight:bold"><a href="${l.url}">${l.url}</a></td></tr>`,
          )
          .join('');
        const textLines = links.map((l) => `${l.label}: ${l.url}`).join('\n');
        await this.mailer.sendMail({
          to: email,
          subject: 'Your AGENTAWK login links',
          html: `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto">
          <h2 style="color:#4f46e5">Find your account</h2>
          <p>Here are the login links associated with <b>${email}</b>:</p>
          <table style="width:100%;background:#f3f4f6;border-radius:10px;padding:16px;border-collapse:collapse">${rows}</table>
          <p style="color:#888;font-size:12px">If you didn't request this, you can safely ignore this email.</p>
        </div>`,
          text: `Your AGENTAWK login links for ${email}:\n${textLines}`,
        });
      }
    }

    // Always identical — never reveal whether the email exists.
    return {
      success: true,
      message:
        "If an account exists for that email, we've sent its login links.",
    };
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

    // Send the reset code via the configured SMTP provider. No-ops (logs a warning)
    // if SMTP_* isn't set yet, so the flow never crashes before keys are dropped in.
    const mailResult = await this.mailer.sendMail({
      to: email,
      subject: 'Your password reset code',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto">
          <h2 style="color:#4f46e5">Password reset</h2>
          <p>Use the code below to reset your password. It is valid for a short time.</p>
          <p style="font-size:26px;font-weight:bold;letter-spacing:4px;background:#f3f4f6;padding:14px 20px;border-radius:10px;text-align:center">${code}</p>
          <p style="color:#888;font-size:12px">If you didn't request this, you can ignore this email.</p>
        </div>`,
      text: `Your password reset code is: ${code}`,
    });

    return {
      message: 'Password reset email sent',
      code: 'EMAIL_SENT',
      emailSent: mailResult.sent,
      // debugCode stays so dev/testing works even before SMTP is configured.
      debugCode: code,
    };
  }

  async verifySignupOtp(email: string, code: string) {
    const record = await this.prisma.otp_codes.findFirst({
      where: { key: email },
      orderBy: { id: 'desc' },
    });

    if (!record || record.code.trim() !== (code || '').trim() || record.expiry < new Date()) {
      throw new BadRequestException('Invalid or expired code');
    }

    const user = await this.prisma.users.findFirst({
      where: { email, modelable_type: 'App\\Models\\Agency', status: 'PENDING' },
    });
    if (!user) {
      throw new BadRequestException('No pending signup found for this email');
    }

    // No password was set at signup — generate one now and email it (with the
    // login URL + username) since this is the only time the user can learn it.
    const generatedPassword = crypto
      .randomBytes(9)
      .toString('base64')
      .replace(/[+/=]/g, '')
      .slice(0, 12);
    const hashedPassword = await bcrypt.hash(generatedPassword, 10);

    // Activate every PENDING row for this email together, all sharing the same
    // generated password — the agency owner login AND its matching Default
    // Workspace login (see register()) are gated behind the same one-time OTP.
    await this.prisma.users.updateMany({
      where: { email, status: 'PENDING' },
      data: { status: 'ACTIVE', email_verified_at: new Date(), password: hashedPassword },
    });

    // Single-use — clear it so the same code can't be replayed.
    await this.prisma.otp_codes.deleteMany({ where: { key: email } });

    const domain = await this.prisma.domains.findFirst({
      where: { modelable_id: user.modelable_id, modelable_type: 'App\\Models\\Agency' },
      orderBy: { id: 'desc' },
    });
    const loginUrl = domain ? `https://${domain.domain}/login` : (process.env.FRONTEND_URL || 'http://localhost:5173') + '/login';

    const mailResult = await this.mailer.sendMail({
      to: email,
      subject: 'Your AGENTAWK login details',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto">
          <h2 style="color:#4f46e5">You're all set!</h2>
          <p>Your email is verified and your account is ready. Here are your login details:</p>
          <table style="width:100%;background:#f3f4f6;border-radius:10px;padding:16px;border-collapse:collapse">
            <tr><td style="padding:6px 10px;color:#666;font-size:13px">URL</td><td style="padding:6px 10px;font-weight:bold"><a href="${loginUrl}">${loginUrl}</a></td></tr>
            <tr><td style="padding:6px 10px;color:#666;font-size:13px">Username</td><td style="padding:6px 10px;font-weight:bold">${email}</td></tr>
            <tr><td style="padding:6px 10px;color:#666;font-size:13px">Password</td><td style="padding:6px 10px;font-weight:bold;letter-spacing:1px">${generatedPassword}</td></tr>
          </table>
          <p style="color:#888;font-size:12px">You can change this password any time from your profile after logging in.</p>
        </div>`,
      text: `Your AGENTAWK login details:\nURL: ${loginUrl}\nUsername: ${email}\nPassword: ${generatedPassword}`,
    });

    return {
      error: false,
      message: 'Email verified successfully — check your email for your login details',
      code: 'VERIFIED',
      emailSent: mailResult.sent,
      // debugPassword stays so dev/testing works even before SMTP is configured.
      debugPassword: generatedPassword,
      loginUrl,
    };
  }

  async resendSignupOtp(email: string) {
    const user = await this.prisma.users.findFirst({
      where: { email, modelable_type: 'App\\Models\\Agency', status: 'PENDING' },
    });
    if (!user) {
      throw new BadRequestException('No pending signup found for this email');
    }
    const result = await this.sendSignupOtp(email);
    return { error: false, message: 'Verification code resent', emailSent: result.sent, debugCode: result.debugCode };
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

    // Keep the Agency-owner + Default-Workspace login (same email, created
    // together at signup) in sync — see the matching note in
    // UsersService.changePassword. Scoped strictly by email match.
    await this.prisma.users.updateMany({
      where: { email: user.email, status: 'ACTIVE' },
      data: { password: hashedPassword },
    });

    // Delete used token
    await this.prisma.password_resets.deleteMany({
      where: { email: data.email }, // Clears all tokens for this email
    });

    return { message: 'Password updated successfully', code: 'SUCCESS' };
  }

  // Note: changePassword was removed from this service — UsersService.changePassword
  // is the single source of truth. See backend/src/users/users.service.ts.

  async loadUserPermissions(userId: bigint, isOwner?: boolean): Promise<string[]> {
    // Owner gets wildcard — all permissions granted. Use the caller-provided
    // is_owner when available to avoid a redundant users lookup on login.
    let owner = isOwner;
    if (owner === undefined) {
      const user = await this.prisma.users.findUnique({
        where: { id: userId },
        select: { is_owner: true },
      });
      owner = user?.is_owner ?? false;
    }
    if (owner) return ['agency.*', 'workspace.*'];

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
