import type { RouteObject } from 'react-router';
import { AppLayout } from './AppLayout';
import { FocusLayout } from './FocusLayout';
import { RedirectIfSignedIn, RequireAuth, RequireOnboarded } from './guards';
import { PublicLayout } from './PublicLayout';
import { RouteError, RouteLoading } from './RouteStates';

/**
 * Route table. Pages are lazy-loaded so each route ships as its own chunk;
 * heavy features (Monaco, charts, media) stay out of the landing bundle.
 */
export const routes: RouteObject[] = [
  {
    // The interview room uses a focus layout without the main navigation.
    element: <FocusLayout />,
    ErrorBoundary: RouteError,
    HydrateFallback: RouteLoading,
    children: [
      {
        element: <RequireAuth />,
        children: [
          {
            element: <RequireOnboarded />,
            children: [
              {
                path: 'app/interviews/:id/room',
                lazy: async () => ({
                  Component: (await import('../features/room/RoomPage')).RoomPage,
                }),
              },
            ],
          },
        ],
      },
    ],
  },
  {
    // Signed-in candidate pages: sidebar shell (dashboard, history, purchases, profile, interviews).
    element: <AppLayout />,
    ErrorBoundary: RouteError,
    HydrateFallback: RouteLoading,
    children: [
      {
        element: <RequireAuth />,
        children: [
          {
            path: 'app',
            element: <RequireOnboarded />,
            children: [
              {
                index: true,
                lazy: async () => ({
                  Component: (await import('../features/dashboard/DashboardPage')).DashboardPage,
                }),
              },
              {
                path: 'profile',
                lazy: async () => ({
                  Component: (await import('../features/profile/ProfilePage')).ProfilePage,
                }),
              },
              {
                path: 'new',
                lazy: async () => ({
                  Component: (await import('../features/interviews/wizard/NewInterviewPage'))
                    .NewInterviewPage,
                }),
              },
              {
                // Resume match score and tailoring suggestions; no interview needed.
                path: 'resume-check',
                lazy: async () => ({
                  Component: (await import('../features/resume-tools/ResumeCheckPage'))
                    .ResumeCheckPage,
                }),
              },
              {
                path: 'interviews/:id/analysis',
                lazy: async () => ({
                  Component: (await import('../features/interviews/AnalysisPage')).AnalysisPage,
                }),
              },
              {
                path: 'interviews/:id/setup',
                lazy: async () => ({
                  Component: (await import('../features/interviews/SetupPage')).SetupPage,
                }),
              },
              {
                // Voice and video interviews: camera, microphone, speaker and connection checks, then consent.
                path: 'interviews/:id/device-check',
                lazy: async () => ({
                  Component: (await import('../features/voice/DeviceCheckPage')).DeviceCheckPage,
                }),
              },
              {
                // Consents the interview asks for (voice processing, recording, session observations).
                path: 'interviews/:id/consent',
                lazy: async () => ({
                  Component: (await import('../features/consent/ConsentPage')).ConsentPage,
                }),
              },
              {
                path: 'interviews/:id/start',
                lazy: async () => ({
                  Component: (await import('../features/interviews/StartPage')).StartPage,
                }),
              },
              {
                path: 'interviews/:id/complete',
                lazy: async () => ({
                  Component: (await import('../features/interviews/CompletePage')).CompletePage,
                }),
              },
              {
                path: 'reports/:id',
                lazy: async () => ({
                  Component: (await import('../features/reports/ReportPage')).ReportPage,
                }),
              },
              {
                // Practice drills: pick a mode for one skill, then the drill's quick result.
                path: 'drills/new',
                lazy: async () => ({
                  Component: (await import('../features/progress/DrillStartPage')).DrillStartPage,
                }),
              },
              {
                path: 'drills/:id',
                lazy: async () => ({
                  Component: (await import('../features/progress/DrillResultPage')).DrillResultPage,
                }),
              },
              {
                path: 'history',
                lazy: async () => ({
                  Component: (await import('../features/reports/HistoryPage')).HistoryPage,
                }),
              },
              {
                path: 'compare',
                lazy: async () => ({
                  Component: (await import('../features/reports/ComparePage')).ComparePage,
                }),
              },
              {
                path: 'checkout/:planCode',
                lazy: async () => ({
                  Component: (await import('../features/payments/CheckoutPage')).CheckoutPage,
                }),
              },
              {
                path: 'payments/:purchaseId',
                lazy: async () => ({
                  Component: (await import('../features/payments/PaymentStatusPage'))
                    .PaymentStatusPage,
                }),
              },
              {
                path: 'purchases',
                lazy: async () => ({
                  Component: (await import('../features/payments/PurchasesPage')).PurchasesPage,
                }),
              },
              {
                // Data rights: export, deletion, consent history, grievances (DPDP Act 2023).
                path: 'privacy',
                lazy: async () => ({
                  Component: (await import('../features/privacy/PrivacyPage')).PrivacyPage,
                }),
              },
            ],
          },
        ],
      },
    ],
  },
  {
    element: <PublicLayout />,
    ErrorBoundary: RouteError,
    HydrateFallback: RouteLoading,
    children: [
      {
        index: true,
        lazy: async () => ({ Component: (await import('../pages/LandingPage')).LandingPage }),
      },
      {
        path: 'pricing',
        lazy: async () => ({
          Component: (await import('../features/payments/PricingPage')).PricingPage,
        }),
      },
      {
        // Company invite links: public, so candidates see the interview before signing in.
        path: 'campaign/:token',
        lazy: async () => ({
          Component: (await import('../features/campaigns/CampaignPage')).CampaignPage,
        }),
      },
      {
        // Personal invites from an organisation (same page; the invite is tracked as opened).
        path: 'campaign/i/:inviteToken',
        lazy: async () => ({
          Component: (await import('../features/campaigns/CampaignPage')).CampaignPage,
        }),
      },
      {
        // Candidate Proof: a read-only report summary shared by link (no sign-in).
        path: 'proof/:token',
        lazy: async () => ({
          Component: (await import('../features/proof/ProofPage')).ProofPage,
        }),
      },
      {
        // Readiness certificate checks: public, the link printed on each certificate.
        path: 'verify/:code',
        lazy: async () => ({
          Component: (await import('../features/progress/VerifyCertificatePage'))
            .VerifyCertificatePage,
        }),
      },
      {
        // One-click unsubscribe from practice emails (signed token, no sign-in).
        path: 'unsubscribe',
        lazy: async () => ({
          Component: (await import('../features/progress/UnsubscribePage')).UnsubscribePage,
        }),
      },
      {
        // Legal pages: public, linked from every footer and the sign-in screen.
        path: 'terms',
        lazy: async () => ({
          Component: (await import('../features/legal/LegalPage')).TermsPage,
        }),
      },
      {
        path: 'privacy-policy',
        lazy: async () => ({
          Component: (await import('../features/legal/LegalPage')).PrivacyPolicyPage,
        }),
      },
      {
        path: 'grievance',
        lazy: async () => ({
          Component: (await import('../features/legal/LegalPage')).GrievancePage,
        }),
      },
      {
        path: 'how-scoring-works',
        lazy: async () => ({
          Component: (await import('../features/legal/LegalPage')).ScoringPage,
        }),
      },
      {
        path: 'account-deleted',
        lazy: async () => ({
          Component: (await import('../features/privacy/AccountDeletedPage')).AccountDeletedPage,
        }),
      },
      {
        element: <RedirectIfSignedIn />,
        children: [
          {
            path: 'login',
            lazy: async () => ({
              Component: (await import('../features/auth/LoginPage')).LoginPage,
            }),
          },
        ],
      },
      {
        element: <RequireAuth />,
        children: [
          {
            path: 'onboarding',
            lazy: async () => ({
              Component: (await import('../features/profile/OnboardingPage')).OnboardingPage,
            }),
          },
        ],
      },
      {
        path: '*',
        lazy: async () => ({ Component: (await import('../pages/NotFoundPage')).NotFoundPage }),
      },
    ],
  },
];
