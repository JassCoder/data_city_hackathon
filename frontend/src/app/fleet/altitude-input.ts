import { ChangeDetectionStrategy, Component, computed, effect, input, output, signal, untracked } from '@angular/core';
import { ALTITUDE, isValidAltitude } from '../core/models';

let seq = 0;

/** Compact altitude: slider + number, validated against the request limits (max 120 m AGL). */
@Component({
  selector: 'app-altitude-input',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="field">
      <label class="field-label" [for]="numberId">Altitude above ground</label>
      <div class="row">
        <input type="range" class="range" [min]="a.min" [max]="a.max" [step]="a.step" [value]="sliderValue()"
               (input)="fromSlider($event)" aria-label="Altitude slider" [attr.aria-valuetext]="value() + ' metres'" />
        <span class="num-wrap">
          <input [id]="numberId" type="number" inputmode="numeric" class="input num" [min]="a.min" [max]="a.max"
                 [step]="a.step" [value]="text()" (input)="fromNumber($event)" [attr.aria-invalid]="!!error()"
                 [attr.aria-describedby]="hintId" data-testid="altitude-number" />
          <span class="unit" aria-hidden="true">m</span>
        </span>
      </div>
      @if (error(); as e) {
        <p class="field-error" role="alert">{{ e }}</p>
      }
      <p class="field-hint" [id]="hintId">
        Planning setting only, not an authorization to fly. Real limits depend on the operation category and airspace.
      </p>
    </div>
  `,
  styles: `
    .row {
      display: flex;
      align-items: center;
      gap: var(--sp-3);
    }
    .range {
      flex: 1;
      min-width: 0;
      accent-color: var(--c-accent);
    }
    .num-wrap {
      position: relative;
      flex: none;
      width: 76px;
    }
    .num-wrap .input {
      padding-right: 22px;
      text-align: right;
    }
    .unit {
      position: absolute;
      right: 8px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--c-muted);
      font-size: var(--fs-12);
      pointer-events: none;
    }
  `,
})
export class AltitudeInputComponent {
  readonly value = input.required<number>();
  readonly valueChange = output<number>();

  protected readonly a = ALTITUDE;
  protected readonly numberId = `alt-${++seq}`;
  protected readonly hintId = `${this.numberId}-hint`;
  /** What the user typed (may be invalid while typing). */
  protected readonly text = signal('');
  protected readonly error = computed(() => {
    const t = this.text().trim();
    const v = Number(t);
    if (t === '' || !Number.isFinite(v)) return `Enter a number from ${ALTITUDE.min} to ${ALTITUDE.max}.`;
    if (v > ALTITUDE.max) return `Maximum is ${ALTITUDE.max} m above ground.`;
    if (v < ALTITUDE.min) return `Minimum is ${ALTITUDE.min} m.`;
    if (!isValidAltitude(v)) return `Use ${ALTITUDE.step} m steps.`;
    return null;
  });
  protected readonly sliderValue = computed(() => (isValidAltitude(this.value()) ? this.value() : ALTITUDE.default));

  constructor() {
    effect(() => {
      const v = this.value();
      untracked(() => {
        if (Number(this.text()) !== v) this.text.set(String(v));
      });
    });
  }

  protected fromSlider(event: Event): void {
    const v = Number((event.target as HTMLInputElement).value);
    this.text.set(String(v));
    this.valueChange.emit(v);
  }

  protected fromNumber(event: Event): void {
    const t = (event.target as HTMLInputElement).value;
    this.text.set(t);
    const v = Number(t);
    // Invalid values are passed on too, so the drone shows it cannot be calculated.
    if (t.trim() !== '' && Number.isFinite(v)) this.valueChange.emit(v);
  }
}
