import type { ElementAnimationAction } from '../types/action';
/** Common MAIC/importer effects. Unsupported effects fail visibly instead of disappearing. */
export function maicAnimationFrames(action: ElementAnimationAction): Keyframe[] {
  switch (action.effect) {
    case 'appear': return [{ opacity: 0 }, { opacity: 1 }];
    case 'disappear': return [{ opacity: 1 }, { opacity: 0 }];
    case 'fadeIn': return [{ opacity: 0 }, { opacity: 1 }];
    case 'fadeOut': return [{ opacity: 1 }, { opacity: 0 }];
    case 'zoomIn': return [{ opacity: 0, transform: 'scale(0.6)' }, { opacity: 1, transform: 'scale(1)' }];
    case 'zoomOut': return [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.6)' }];
    case 'slideInLeft': return [{ opacity: 0, transform: 'translateX(-24px)' }, { opacity: 1, transform: 'translateX(0)' }];
    case 'slideInRight': return [{ opacity: 0, transform: 'translateX(24px)' }, { opacity: 1, transform: 'translateX(0)' }];
    case 'wipeDown': return [{ clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0)' }];
    case 'scaleIn': return [{ transform: 'scale(0)' }, { transform: 'scale(1)' }];
    case 'bounceInBottom': if (action.motion) return [{ opacity: 0, transform: `translateY(${action.motion.fromY}px)`, offset: 0, easing: 'cubic-bezier(0,0,0.58,1)' }, { opacity: 0.9, transform: `translateY(${-action.motion.fromY*.03}px)`, offset: 0.9, easing: 'cubic-bezier(0.42,0,1,1)' }, { opacity: 1, transform: 'translateY(0)', offset: 1 }]; break;
    case 'grow150': return [{ transform: 'scale(1)' }, { transform: 'scale(1.5)' }];
    case 'pulse': return [{ transform: 'scale(1)' }, { transform: 'scale(1.1)' }, { transform: 'scale(1)' }];
    case 'gentleRotate': return [{ transform: 'rotate(0deg)' }, { transform: 'rotate(3deg)' }, { transform: 'rotate(0deg)' }];
    case 'pptxMotion': if (action.motion) return (action.motion.path ?? [{ x: action.motion.fromX, y: action.motion.fromY }, { x: 0, y: 0 }]).map(p => ({ transform: `translate(${p.x}px,${p.y}px)` })); break;
    case 'pptxRotation': if (action.rotation) return [{ transform: `rotate(${action.rotation.fromDeg}deg)` }, { transform: `rotate(${action.rotation.toDeg}deg)` }]; break;
  }
  throw new Error(`MAIC animation is not supported offline: ${action.effect}`);
}
