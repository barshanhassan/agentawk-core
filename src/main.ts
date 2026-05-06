import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: true,
    credentials: true,
  });
  app.setGlobalPrefix('api');
  await app.listen(process.env.PORT ?? 3001);
}
// Triggering rebuild for Gallery local storage changes
bootstrap().catch((err) => {
  console.error('FAILED TO START APPLICATION');
  console.error(err);
  process.exit(1);
});
