import type { Page } from "@playwright/test";

// Replaces Stripe.js with a stub whose Payment Element is one input and whose
// confirmPayment asks the isolated Stripe simulation (port 3111) to authorize the intent.
export function simulateStripeJs(page: Page) {
  return page.route("https://js.stripe.com/**", route => route.fulfill({ contentType: "application/javascript", body: `
    window.Stripe = function() {
      return { _registerWrapper(){}, registerAppInfo(){}, createToken(){}, createPaymentMethod(){}, confirmCardPayment(){},
        elements(options) {
          const elements = { secret: options.clientSecret, update(){}, submit:async()=>({}),
            create() {
              const handlers = {};
              return { on(event,fn){handlers[event]=fn}, off(){}, update(){}, destroy(){}, unmount(){},
                mount(node) {
                  const input=document.createElement('input'); input.setAttribute('aria-label','Simulated card number'); node.appendChild(input);
                  setTimeout(()=>handlers.ready?.(),0);
                }
              };
            }, getElement(){return null} };
          return elements;
        },
        async confirmPayment({elements}) {
          const id=elements.secret.split('_secret')[0];
          const response=await fetch('http://127.0.0.1:3111/fixture/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});
          return {paymentIntent:await response.json()};
        }
      };
    };` }));
}
