const { sum } = require('../src/index');

test('intentional fail to trigger CI auto-fix', () => {
    expect(sum(2, 2)).toBe(5); // bilerek başarısız
});


