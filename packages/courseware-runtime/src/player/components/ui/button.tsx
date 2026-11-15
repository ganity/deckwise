import type { ButtonHTMLAttributes } from 'react';
export function Button({variant: _variant, ...props}: ButtonHTMLAttributes<HTMLButtonElement> & {variant?: 'outline'}) {return <button type="button" {...props}/>;}
