import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      // Allow requests with no origin (curl, Postman, mobile)
      if (!origin) return callback(null, true);
      const allowed =
        origin === 'https://ezconn-fe.web.app' ||
        /^https?:\/\/([\w-]+\.)?(localhost|laglobal\.local)(:\d+)?$/.test(origin);
      callback(allowed ? null : new Error('CORS blocked'), allowed);
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });
  await app.listen(process.env.PORT ?? 3001);
}
// Triggering rebuild for Gallery local storage changes
bootstrap().catch((err) => {
  console.error('FAILED TO START APPLICATION');
  console.error(err);
  process.exit(1);
});
