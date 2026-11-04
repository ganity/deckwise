import { describe, expect, it } from 'vitest';
import { gradeChoiceQuestions } from './MaicAssessmentQuiz';
describe('pinned cloud-web assessment choice grading', () => {
  it('normalizes labels and explicit option answers, preserving weighted points and multiple answer order', () => {
    const result = gradeChoiceQuestions([
      {id:'single',type:'single',question:'Greeting?',options:[{value:'A',label:'Hello'},{value:'B',label:'Bye'}],answer:['Option A: Hello'],points:3},
      {id:'multi',type:'multiple',question:'Two',options:[{value:'A',label:'One'},{value:'B',label:'Two'}],answer:['B','A'],points:2},
    ],{single:'hello',multi:['A','B']});
    expect(result.map(r=>[r.status,r.earned])).toEqual([['correct',3],['correct',2]]);
  });
  it('never returns a fabricated score for short answer or a question requiring online assessment', () => {
    expect(gradeChoiceQuestions([{id:'q',type:'short_answer',question:'Say Hello',answer:['Hello'],points:8}],{q:'Hello'})).toEqual([]);
    expect(gradeChoiceQuestions([{id:'q',type:'single',question:'Opinion',answer:[],hasAnswer:false}],{q:'A'})).toEqual([]);
  });
});
