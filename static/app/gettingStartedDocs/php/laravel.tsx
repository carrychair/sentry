import ExternalLink from 'sentry/components/links/externalLink';
import {StepType} from 'sentry/components/onboarding/gettingStartedDoc/step';
import type {
  Docs,
  DocsParams,
  OnboardingConfig,
} from 'sentry/components/onboarding/gettingStartedDoc/types';
import {
  getCrashReportModalConfigDescription,
  getCrashReportModalIntroduction,
  getCrashReportSDKInstallFirstStep,
} from 'sentry/components/onboarding/gettingStartedDoc/utils/feedbackOnboarding';
import replayOnboardingJsLoader from 'sentry/gettingStartedDocs/javascript/jsLoader/jsLoader';
import {t, tct} from 'sentry/locale';

type Params = DocsParams;

const getExceptionHandlerSnippet = () => `
public function register() {
  $this->reportable(function (Throwable $e) {
    if (app()->bound('sentry')) {
      app('sentry')->captureException($e);
    }
  });
}`;

const getConfigureSnippet = (params: Params) =>
  `SENTRY_LARAVEL_DSN=${params.dsn}${
    params.isPerformanceSelected
      ? `
# Specify a fixed sample rate
SENTRY_TRACES_SAMPLE_RATE=1.0`
      : ''
  }${
    params.isProfilingSelected
      ? `
# Set a sampling rate for profiling - this is relative to traces_sample_rate
SENTRY_PROFILES_SAMPLE_RATE=1.0`
      : ''
  }`;

const getMetricsInstallSnippet = () => `
composer install sentry/sentry-laravel

composer update sentry/sentry-laravel -W`;

const getMetricsVerifySnippet = () => `
use function \\Sentry\\metrics;

// Add 4 to a counter named 'hits'
metrics()->increment('hits', 4);
metrics()->flush();

// We recommend registering the flush call in a shutdown function
register_shutdown_function(static fn () => metrics()->flush());

// Or call flush in a Terminable Middleware

use Closure;
use Illuminate\\Http\\Request;
use Symfony\\Component\\HttpFoundation\\Response;

use function \\Sentry\\metrics;

class SentryMetricsMiddleware
{
		public function handle(Request $request, Closure $next): Response
    {
        return $next($request);
    }

    public function terminate(Request $request, Response $response): void
    {
        metrics()->flush();
    }
}`;

const onboarding: OnboardingConfig = {
  introduction: () =>
    tct(
      'This guide is for Laravel 8+. We also provide instructions for [otherVersionsLink:other versions] as well as [lumenSpecificLink:Lumen-specific instructions].',
      {
        otherVersionsLink: (
          <ExternalLink href="https://docs.sentry.io/platforms/php/guides/laravel/other-versions/" />
        ),
        lumenSpecificLink: (
          <ExternalLink href="https://docs.sentry.io/platforms/php/guides/laravel/other-versions/lumen/" />
        ),
      }
    ),
  install: (params: Params) => [
    {
      type: StepType.INSTALL,
      configurations: [
        {
          description: tct('Install the [code:sentry/sentry-laravel] package:', {
            code: <code />,
          }),
          language: 'bash',
          code: `composer require sentry/sentry-laravel`,
        },
        ...(params.isProfilingSelected
          ? [
              {
                description: t('Install the Excimer extension via PECL:'),
                language: 'bash',
                code: 'pecl install excimer',
              },
            ]
          : []),
        {
          description: tct(
            'Enable capturing unhandled exception to report to Sentry by making the following change to your [code:App/Exceptions/Handler.php]:',
            {
              code: <code />,
            }
          ),
          language: 'php',
          code: getExceptionHandlerSnippet(),
        },
      ],
    },
  ],
  configure: (params: Params) => [
    {
      type: StepType.CONFIGURE,
      configurations: [
        {
          description: t('Configure the Sentry DSN with this command:'),
          language: 'shell',
          code: `php artisan sentry:publish --dsn=${params.dsn}`,
        },
        {
          description: tct(
            'It creates the config file ([sentryPHPCode:config/sentry.php]) and adds the [dsnCode:DSN] to your [envCode:.env] file where you can add further configuration options:',
            {sentryPHPCode: <code />, dsnCode: <code />, envCode: <code />}
          ),
          language: 'shell',
          code: getConfigureSnippet(params),
        },
      ],
    },
  ],
  verify: () => [
    {
      type: StepType.VERIFY,
      configurations: [
        {
          description: tct(
            'You can test your configuration using the provided [code:sentry:test] artisan command:',
            {
              code: <code />,
            }
          ),
          language: 'shell',
          code: 'php artisan sentry:test',
        },
      ],
    },
  ],
  nextSteps: () => [],
};

const customMetricsOnboarding: OnboardingConfig = {
  install: () => [
    {
      type: StepType.INSTALL,
      description: tct(
        'You need a minimum version [codeVersionLaravel:4.0.0] of the Laravel SDK and a minimum version [codeVersion:4.3.0] of the PHP SDK installed',
        {
          codeVersionLaravel: <code />,
          codeVersion: <code />,
        }
      ),
      configurations: [
        {
          language: 'bash',
          code: getMetricsInstallSnippet(),
        },
      ],
    },
  ],
  configure: () => [
    {
      type: StepType.CONFIGURE,
      description: tct(
        'Once the SDK is installed or updated, you can enable code locations being emitted with your metrics in your [code:config/sentry.php] file:',
        {
          code: <code />,
        }
      ),
      configurations: [
        {
          code: [
            {
              label: 'PHP',
              value: 'php',
              language: 'php',
              code: `'attach_metric_code_locations' => true,`,
            },
          ],
        },
      ],
    },
  ],
  verify: () => [
    {
      type: StepType.VERIFY,
      description: tct(
        "Then you'll be able to add metrics as [codeCounters:counters], [codeSets:sets], [codeDistribution:distributions], and [codeGauge:gauges]. Try out this example:",
        {
          codeCounters: <code />,
          codeSets: <code />,
          codeDistribution: <code />,
          codeGauge: <code />,
          codeNamespace: <code />,
        }
      ),
      configurations: [
        {
          code: [
            {
              label: 'PHP',
              value: 'php',
              language: 'php',
              code: getMetricsVerifySnippet(),
            },
          ],
        },
        {
          description: t(
            'With a bit of delay you can see the data appear in the Sentry UI.'
          ),
        },
        {
          description: tct(
            'Learn more about metrics and how to configure them, by reading the [docsLink:docs].',
            {
              docsLink: (
                <ExternalLink href="https://docs.sentry.io/platforms/php/guides/laravel/metrics/" />
              ),
            }
          ),
        },
      ],
    },
  ],
};

const crashReportOnboarding: OnboardingConfig = {
  introduction: () => getCrashReportModalIntroduction(),
  install: (params: Params) => [
    {
      type: StepType.INSTALL,
      configurations: [
        getCrashReportSDKInstallFirstStep(params),
        {
          description: tct(
            'Next, create [code:resources/views/errors/500.blade.php], and embed the feedback code:',
            {code: <code />}
          ),
          code: [
            {
              label: 'HTML',
              value: 'html',
              language: 'html',
              code: `<div class="content">
  <div class="title">Something went wrong.</div>

  @if(app()->bound('sentry') && app('sentry')->getLastEventId())
  <div class="subtitle">Error ID: {{ app('sentry')->getLastEventId() }}</div>
  <script>
    Sentry.init({ dsn: '${params.dsn}' });
    Sentry.showReportDialog({
      eventId: '{{ app('sentry')->getLastEventId() }}'
    });
  </script>
  @endif
</div>`,
            },
          ],
        },
        {
          description: tct(
            'For Laravel 5 up to 5.4 there is some extra work needed. You need to open up [codeApp:App/Exceptions/Handler.php] and extend the [codeRender:render] method to make sure the 500 error is rendered as a view correctly, in 5.5+ this step is not required anymore.',
            {code: <code />}
          ),
          code: [
            {
              label: 'PHP',
              value: 'php',
              language: 'php',
              code: `<?php

use Symfony\Component\HttpKernel\Exception\HttpException;

class Handler extends ExceptionHandler
{
    public function report(Exception $exception)
    {
        if (app()->bound('sentry') && $this->shouldReport($exception)) {
            app('sentry')->captureException($exception);
        }

        parent::report($exception);
    }

    // This method is ONLY needed for Laravel 5 up to 5.4.
    // You can skip this method if you are using Laravel 5.5+.
    public function render($request, Exception $exception)
    {
        // Convert all non-http exceptions to a proper 500 http exception
        // if we don't do this exceptions are shown as a default template
        // instead of our own view in resources/views/errors/500.blade.php
        if ($this->shouldReport($exception) && !$this->isHttpException($exception) && !config('app.debug')) {
            $exception = new HttpException(500, 'Whoops!');
        }

        return parent::render($request, $exception);
    }
}`,
            },
          ],
        },
      ],
    },
  ],
  configure: () => [
    {
      type: StepType.CONFIGURE,
      description: getCrashReportModalConfigDescription({
        link: 'https://docs.sentry.io/platforms/php/guides/laravel/user-feedback/configuration/#crash-report-modal',
      }),
    },
  ],
  verify: () => [],
  nextSteps: () => [],
};

const docs: Docs = {
  onboarding,
  replayOnboardingJsLoader,
  customMetricsOnboarding,
  crashReportOnboarding,
};

export default docs;
