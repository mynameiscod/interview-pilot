export const RAZORPAY_CHECKOUT_URL = 'https://checkout.razorpay.com/v1/checkout.js';

let loading: Promise<NonNullable<Window['Razorpay']>> | null = null;

/** Loads Razorpay Checkout once (a single script tag, shared by every caller). */
export function loadRazorpay(): Promise<NonNullable<Window['Razorpay']>> {
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = RAZORPAY_CHECKOUT_URL;
    script.async = true;
    script.onload = () => {
      if (window.Razorpay) resolve(window.Razorpay);
      else reject(new Error('Razorpay Checkout did not load'));
    };
    script.onerror = () => {
      script.remove();
      reject(new Error('Razorpay Checkout did not load'));
    };
    document.head.appendChild(script);
  });
  // Let a later attempt try again after a failure (e.g. a flaky connection).
  loading.catch(() => {
    loading = null;
  });
  return loading;
}
